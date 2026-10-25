import { isValidBase64 } from "@openclaw/media-core/base64";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateUsersLinkEmailParams,
  validateUsersMergeParams,
  validateUsersListParams,
  validateUsersPrefsGetParams,
  validateUsersPrefsSetParams,
  validateUsersSelfParams,
  validateUsersSetAvatarParams,
  validateUsersSetDisplayNameParams,
  validateUsersSetRoleParams,
  type ErrorShape,
  validateUsersBackgroundGetParams,
  validateUsersBackgroundUploadParams,
  validateUsersBackgroundRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { USER_BACKGROUND_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/background-preferences.js";
import { resolveGatewayPersonalToolParticipant } from "../../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { UserBackgroundInputError } from "../../state/user-background-image.js";
import {
  getUserBackground,
  removeUserBackground,
  uploadUserBackground,
} from "../../state/user-background.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { profileCatalogPath } from "../../state/user-profile-identity.read.js";
import {
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
  readUserProfileSnapshot,
} from "../../state/user-profile-list.js";
import {
  linkCanonicalUserProfileEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { UserProfileMergeError, UserProfileOwnerError } from "../../state/user-profiles-schema.js";
import { listProfiles, UserProfileNotFoundError } from "../../state/user-profiles.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import { isIneligiblePersonalGatewayCaller } from "./gateway-personal-caller.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { usersAuthConnectHandlers } from "./users-auth-connect.js";
import { usersChannelIdentityHandlers } from "./users-channel-identities.js";
import { usersGitHubHandlers } from "./users-github.js";
import { usersPersonalFileHandlers } from "./users-personal-file.js";
import {
  prepareAuthenticatedProfile,
  prepareProfileMutationAccess,
  prepareUserProfileAdministration,
} from "./users-profile-access.js";
import { assertValidParams, defineValidatedGatewayHandler, type Validator } from "./validation.js";

/** Bind private profile work to this live human connection before asynchronous image decoding. */
async function prepareUserBackgroundAction(
  options: Omit<GatewayRequestHandlerOptions, "params">,
  scope: "operator.read" | "operator.write",
) {
  const { client, context } = options;
  const lifetime = readGatewayRequestMutationAuthority(options);
  const reference = client?.authenticatedUserProfile?.profileId;
  if (!reference) {
    throw new Error("Backgrounds require an authenticated profile");
  }
  lifetime.assertLifetimeCurrent();
  const profile = await prepareUserProfileRoleAuthority(reference);
  const owner = profile?.profileId;
  if (!owner || !profile) {
    throw new Error("Backgrounds require an authenticated profile");
  }
  const assertCurrent = () => {
    lifetime.assertLifetimeCurrent();
    lifetime.expectedProfileBinding?.assertCurrent();
    if (
      !owner ||
      !client?.connId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      options.signal?.aborted ||
      client.connect.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      isGatewayClientProfilePending(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId) ||
      !profile.isCurrent() ||
      client.authenticatedUserProfile?.profileId !== reference
    ) {
      throw new Error("Background request no longer belongs to a connected profile");
    }
    const policy = resolveOperatorRolePolicyForAssignment(
      owner,
      profile.role,
      context.getRuntimeConfig(),
      profile.githubLogin ?? null,
    );
    if (
      ![client.connect.scopes ?? [], ...(policy ? [policy.scopes] : [])].every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    ) {
      throw new Error("Background request no longer has the required profile scope");
    }
  };
  assertCurrent();
  return { owner, assertCurrent };
}

function backgroundHandler<P extends object>(
  operation: "get" | "upload" | "remove",
  validate: Validator<P>,
  run: (
    action: Awaited<ReturnType<typeof prepareUserBackgroundAction>>,
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: P },
  ) => Promise<Awaited<ReturnType<typeof getUserBackground>>>,
  mapError: (error: unknown) => ErrorShape,
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(
    `users.background.${operation}`,
    validate,
    async (options) => {
      const { client, respond, context } = options;
      if (!client?.authenticatedUserProfile) {
        respond(true, { status: "no_durable_identity" });
        return;
      }
      const action = await prepareUserBackgroundAction(
        options,
        operation === "get" ? "operator.read" : "operator.write",
      );
      const result = await run(action, options);
      action.assertCurrent();
      respond(true, result);
      if (operation !== "get" && result.status === "ok") {
        publishUserPreferencesChanged(context, action.owner, [USER_BACKGROUND_PREFERENCE_KEY]);
      }
    },
    mapError,
  );
}

function refreshConnectedProfile(
  context: GatewayRequestHandlerOptions["context"],
  profileId: string,
): void {
  const current = readResidentUserProfileRevision(profileId, profileCatalogPath({}));
  if (current) {
    context.refreshConnectedUserProfile?.({
      ...projectUserProfileDisplay(current),
      updatedAt: current.updated_at,
    });
  }
}

function profileError(error: unknown) {
  if (
    error instanceof UserProfileNotFoundError ||
    error instanceof UserProfileOwnerError ||
    error instanceof UserProfileMergeError
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
}

function preparePersonalPreferences(client: GatewayRequestHandlerOptions["client"]) {
  const unavailable =
    "Personal settings are unavailable in this turn. Ask in your own Control UI turn with a new message.";
  try {
    const participant = resolveGatewayPersonalToolParticipant(
      client?.internal?.agentRuntimeIdentity,
      { requireSingleParticipant: true },
    );
    return () => {
      try {
        participant?.assertCurrent();
      } catch {
        throw new Error(unavailable);
      }
    };
  } catch {
    throw new Error(unavailable);
  }
}

export const usersHandlers: GatewayRequestHandlers = {
  ...usersAuthConnectHandlers,
  ...usersChannelIdentityHandlers,
  ...usersGitHubHandlers,
  ...usersPersonalFileHandlers,
  "users.background.get": backgroundHandler(
    "get",
    validateUsersBackgroundGetParams,
    (action) => getUserBackground(action.owner, action),
    () => errorShape(ErrorCodes.FORBIDDEN, "Backgrounds require a current authenticated profile"),
  ),
  "users.background.upload": backgroundHandler(
    "upload",
    validateUsersBackgroundUploadParams,
    (action, { params, signal }) =>
      uploadUserBackground(action.owner, params, { ...action, signal }),
    (error) =>
      errorShape(
        error instanceof UserBackgroundInputError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Background upload failed",
      ),
  ),
  "users.background.remove": backgroundHandler(
    "remove",
    validateUsersBackgroundRemoveParams,
    (action, { params }) => removeUserBackground(action.owner, params, action),
    () =>
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Background removal failed; reload your preference and retry",
      ),
  ),
  "users.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUsersListParams, "users.list", respond)) {
      return;
    }
    const { githubAccountIds } = params;
    const result =
      githubAccountIds === undefined
        ? { profiles: await listProfiles() }
        : await readUserProfileSnapshot(githubAccountIds);
    const cfg = context.getRuntimeConfig();
    const profilesById = new Map(result.profiles.map((profile) => [profile.id, profile]));
    respond(true, {
      ...result,
      profiles: result.profiles.map((profile) => {
        const canonical = profilesById.get(profile.mergedInto ?? profile.id) ?? profile;
        return Object.assign(
          profile,
          resolveOperatorRoleSelection(
            canonical.id,
            canonical.role ?? null,
            cfg,
            canonical.githubIdentity?.host ? null : (canonical.githubIdentity?.login ?? null),
          ),
        );
      }),
    });
  },
  "users.self": async (options) => {
    const { client, params, respond } = options;
    if (!assertValidParams(params, validateUsersSelfParams, "users.self", respond)) {
      return;
    }
    if (!client?.authenticatedUserId && !client?.authenticatedUserProfile) {
      respondError(respond, ErrorCodes.FORBIDDEN, "users.self requires an authenticated user");
      return;
    }
    try {
      let syncError: unknown;
      if (client.authenticatedGitHubIdentitySync) {
        try {
          await client.authenticatedGitHubIdentitySync();
        } catch (error) {
          // A previously attached immutable profile stays usable; unresolved aliases stay hidden.
          syncError = error;
        }
      }
      const profile = await prepareAuthenticatedProfile(options, true);
      profile.assertCurrent();
      const profileId = profile.profileId;
      if (!profileId || !profile.listItem) {
        respond(false, undefined, authenticatedProfileUnavailableError(syncError));
        return;
      }
      respond(true, { profile: profile.listItem });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.get": async ({ client, params, respond, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateUsersPrefsGetParams, "users.prefs.get", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const assertCurrent = preparePersonalPreferences(client);
      const preferences = await getCanonicalUserPreferences(profileId, params.keys);
      assertCurrent();
      sessionMutationAuthorization?.assertCurrent();
      if (!preferences) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "ok", entries: preferences.entries }, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.set": async (options) => {
    const { client, context, params, respond } = options;
    if (!assertValidParams(params, validateUsersPrefsSetParams, "users.prefs.set", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const assertPersonal = preparePersonalPreferences(client);
      const backgroundAction = Object.hasOwn(params.entries, "ui.background")
        ? await prepareUserBackgroundAction(options, "operator.write")
        : undefined;
      const assertCurrent = () => {
        assertPersonal();
        options.sessionMutationAuthorization?.assertCurrent();
        backgroundAction?.assertCurrent();
      };
      const result = await setCanonicalUserPreferences(profileId, params.entries, {
        expectedEntries: params.expectedEntries,
        assertCurrent,
      });
      if (!result) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      if (!result.ok) {
        if (result.error.code === "conflict") {
          respond(true, { status: "conflict" }, undefined);
          return;
        }
        if (result.error.code === "profile-key-limit") {
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            `users.prefs.set exceeds the ${result.error.limit}-key profile limit (current count: ${result.error.currentCount})`,
            {
              details: {
                code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
                limit: result.error.limit,
                currentCount: result.error.currentCount,
              },
            },
          );
          return;
        }
        const key = "key" in result.error ? ` for ${result.error.key}` : "";
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `invalid users.prefs.set entry${key}: ${result.error.code}`,
        );
        return;
      }
      respond(true, { status: "ok" }, undefined);
      publishUserPreferencesChanged(context, result.value.profileId, Object.keys(params.entries));
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.linkEmail": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersLinkEmailParams, "users.linkEmail", respond)) {
      return;
    }
    const email = params.email.trim();
    if (!email) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "email must not be empty");
      return;
    }
    const targetProfileId = params.targetProfileId;
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      const { profile } = await linkCanonicalUserProfileEmail(email, targetProfileId, {
        assertCurrent,
      });
      assertCurrent();
      refreshConnectedProfile(context, profile.id);
      broadcastChatMetadataChanged(context);
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.merge": defineValidatedGatewayHandler(
    "users.merge",
    validateUsersMergeParams,
    async (options) => {
      const { context, params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      holdGatewayPolicyResponse(respond);
      const { profile, movedAliasKinds } = await mergeCanonicalUserProfiles(
        params.sourceProfileId,
        params.targetProfileId,
        {
          assertCurrent,
          onCommitted: (profileIds) => {
            for (const profileId of profileIds) {
              invalidateOperatorRolePolicy(profileId);
              context.disconnectClientsForUserProfile?.(profileId);
            }
          },
        },
      );
      let canPublish = true;
      try {
        assertCurrent();
      } catch {
        // A committed merge can revoke its requester; its receipt still completes the held response.
        canPublish = false;
      }
      if (canPublish) {
        refreshConnectedProfile(context, profile.id);
        broadcastChatMetadataChanged(context);
      }
      respond(true, { profile, movedAliasKinds });
    },
    profileError,
  ),
  "users.setDisplayName": defineValidatedGatewayHandler(
    "users.setDisplayName",
    validateUsersSetDisplayNameParams,
    async (options) => {
      const { context, params, respond } = options;
      const assertCurrent = await prepareProfileMutationAccess(options, params.profileId);
      if (!assertCurrent) {
        return;
      }
      const { profile } = await setCanonicalUserProfileDisplayName(
        params.profileId,
        params.displayName,
        { assertCurrent },
      );
      assertCurrent();
      refreshConnectedProfile(context, profile.id);
      respond(true, { profile });
    },
    profileError,
  ),
  "users.setRole": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersSetRoleParams, "users.setRole", respond)) {
      return;
    }
    const { profileId, role } = params;
    const isConfiguredRole = () => {
      const definitions = context.getRuntimeConfig().gateway?.roles?.definitions;
      return role === null || (definitions !== undefined && Object.hasOwn(definitions, role));
    };
    const unknownRoleMessage = `unknown operator role "${role}"; define it under gateway.roles.definitions before assigning it`;
    if (!isConfiguredRole()) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, unknownRoleMessage);
      return;
    }
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      holdGatewayPolicyResponse(respond);
      const profile = await setCanonicalUserProfileRole(profileId, role, {
        assertCurrent: () => {
          assertCurrent();
          if (!isConfiguredRole()) {
            throw new Error(unknownRoleMessage);
          }
        },
        onCommitted: (canonicalProfileId) => {
          invalidateOperatorRolePolicy(canonicalProfileId);
          context.disconnectClientsForUserProfile?.(canonicalProfileId);
        },
      });
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setAvatar": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersSetAvatarParams, "users.setAvatar", respond)) {
      return;
    }
    const avatarBase64 = params.avatarBase64.trim();
    if (!isValidBase64(avatarBase64)) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "avatarBase64 must be base64");
      return;
    }
    const bytes = Buffer.from(avatarBase64, "base64");
    try {
      const assertCurrent = await prepareProfileMutationAccess(options, params.profileId);
      if (!assertCurrent) {
        return;
      }
      const result = await setCanonicalUserProfileAvatar(params.profileId, bytes, params.mime, {
        assertCurrent,
      });
      assertCurrent();
      if (!result.ok) {
        respondError(respond, ErrorCodes.INVALID_REQUEST, result.error.code);
        return;
      }
      const { profile, display } = result.value;
      refreshConnectedProfile(context, profile.id);
      respond(true, { profile, avatarRevision: display.avatarRevision });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
};
