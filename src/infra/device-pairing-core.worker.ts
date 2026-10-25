import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import * as approval from "./device-pairing-approval.kernel.js";
import * as core from "./device-pairing-core.kernel.js";
import type {
  RotateDeviceTokenResult,
  RevokeDeviceTokenResult,
} from "./device-pairing-core.types.js";
import { devicePairingMutation } from "./device-pairing-dispatch.worker.js";
import {
  clearNodePairingGenerationState,
  listApprovedPairedDeviceRoles,
  resolveApprovedDeviceScopeBaseline,
  resolveNodePairingGeneration,
} from "./device-pairing-identity.js";
import {
  registerDevicePairingJoinCodeInWorker,
  redeemDevicePairingJoinCodeInWorker,
} from "./device-pairing-join-code.worker.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  loadDevicePairingStateForMutation,
  normalizeDevicePairingRole,
} from "./device-pairing-state.kernel.js";
import {
  persistDevicePairingStoreState as persistState,
  updatePairedDeviceInTransaction,
} from "./device-pairing-store.js";
import {
  reusablePairedDeviceToken,
  scopesWithinApprovedDeviceBaseline,
  verifyPairedDeviceToken,
  type DeviceTokenVerification,
} from "./device-pairing-token-policy.js";
import { createDeviceAuthToken } from "./device-pairing-token-utils.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";

export const devicePairingOperations = {
  "devicePairing.registerJoinCode": devicePairingMutation(
    (input: Parameters<typeof registerDevicePairingJoinCodeInWorker>[1], { database }) =>
      registerDevicePairingJoinCodeInWorker(database.db, input),
    { publishPairing: false },
  ),
  "devicePairing.redeemJoinCode": devicePairingMutation(
    (input: Parameters<typeof redeemDevicePairingJoinCodeInWorker>[1], { database }) =>
      redeemDevicePairingJoinCodeInWorker(database.db, input),
    { publishPairing: false },
  ),
  "devicePairing.request": devicePairingMutation(
    (input: { request: Parameters<typeof core.requestDevicePairingInWorker>[0]; nowMs: number }) =>
      core.requestDevicePairingInWorker(input.request, input.nowMs),
  ),
  "devicePairing.reject": devicePairingMutation(
    (input: { requestId: string; nowMs: number }, { database }) =>
      core.rejectDevicePairingInWorker(database, input.requestId, input.nowMs),
  ),
  "devicePairing.remove": devicePairingMutation((input: { deviceId: string; nowMs: number }) =>
    core.removePairedDeviceInWorker(input.deviceId, input.nowMs),
  ),
  "devicePairing.pruneSilent": devicePairingMutation(
    core.pruneSupersededSilentPairedDevicesInWorker,
  ),
  "devicePairing.removeRole": devicePairingMutation(core.removePairedDeviceRoleInWorker),
  "devicePairing.updateMetadata": devicePairingMutation(
    (input: {
      deviceId: string;
      patch: Parameters<typeof core.updatePairedDeviceMetadataInWorker>[1];
      accessIdentity?: Parameters<typeof core.updatePairedDeviceMetadataInWorker>[2];
    }) =>
      core.updatePairedDeviceMetadataInWorker(input.deviceId, input.patch, input.accessIdentity),
    { pairedDeviceId: (input) => input.deviceId },
  ),
  "devicePairing.updatePresence": devicePairingMutation(
    (input: {
      deviceId: string;
      patch: Parameters<typeof core.updatePairedDevicePresenceInWorker>[1];
      expectedPairingGeneration: Parameters<typeof core.updatePairedDevicePresenceInWorker>[2];
    }) =>
      core.updatePairedDevicePresenceInWorker(
        input.deviceId,
        input.patch,
        input.expectedPairingGeneration,
      ),
    { pairedDeviceId: (input) => input.deviceId },
  ),
  "devicePairing.approve": devicePairingMutation(
    (input: {
      requestId: string;
      options?: Parameters<typeof approval.approveDevicePairingInWorker>[1];
      nowMs: number;
    }) => approval.approveDevicePairingInWorker(input.requestId, input.options, input.nowMs),
  ),
  "devicePairing.approveBootstrap": devicePairingMutation(
    (
      input: {
        requestId: string;
        bootstrapProfile: Parameters<typeof approval.approveBootstrapDevicePairingInWorker>[1];
        accessMetadata?: NonNullable<
          Parameters<typeof approval.approveBootstrapDevicePairingInWorker>[2]
        >["accessMetadata"];
        nowMs: number;
      },
      { recordTokenReplacement },
    ) => {
      const result = approval.approveBootstrapDevicePairingInWorker(
        input.requestId,
        input.bootstrapProfile,
        { accessMetadata: input.accessMetadata },
        input.nowMs,
      );
      if (result.result?.status === "approved" && result.replacedRoles.length > 0) {
        recordTokenReplacement({
          deviceId: result.result.device.deviceId,
          roles: result.replacedRoles,
        });
      }
      return result;
    },
  ),
  "devicePairing.verifyToken": devicePairingMutation(
    function (params: {
      deviceId: string;
      token: string;
      role: string;
      scopes: string[];
      requiredSharedGatewaySessionGeneration?: string;
      nowMs: number;
    }): DeviceTokenVerification {
      return updatePairedDeviceInTransaction<DeviceTokenVerification>(params.deviceId, (device) => {
        const value = verifyPairedDeviceToken(device, params);
        if (!value.ok || !device) {
          return { value };
        }
        const role = params.role.trim();
        const entry = device.tokens![role]!;
        return {
          value,
          patch: {
            tokens: { ...device.tokens, [role]: { ...entry, lastUsedAtMs: params.nowMs } },
            lastSeenAtMs: params.nowMs,
            lastSeenReason: "device-token-auth",
          },
        };
      });
    },
    {
      pairedDeviceId: (input) => input.deviceId,
    },
  ),
  "devicePairing.ensureToken": devicePairingMutation(function (params: {
    deviceId: string;
    role: string;
    scopes: string[];
    issuer?: DeviceAuthToken["issuer"];
    nowMs: number;
  }): DeviceAuthToken | null {
    return updatePairedDeviceInTransaction<DeviceAuthToken | null>(params.deviceId, (paired) => {
      requestDevicePairingMutationAdmission({ kind: "pairing-token-issuance" });
      const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
      const context = resolveDeviceTokenUpdateContext({
        device: paired,
        role: params.role,
      });
      if (!context) {
        return { value: null };
      }
      const { device, role, tokens, existing } = context;
      const previousNodeGeneration = resolveNodePairingGeneration(device);
      const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
      if (
        !scopesWithinApprovedDeviceBaseline({
          role,
          scopes: requestedScopes,
          approvedScopes,
        })
      ) {
        return { value: null };
      }
      const reusable = reusablePairedDeviceToken(device, params);
      if (reusable) {
        return { value: reusable };
      }
      const now = params.nowMs;
      const next = createDeviceAuthToken({
        role,
        scopes: requestedScopes,
        issuer: params.issuer,
        existing,
        now,
        rotatedAtMs: existing ? now : undefined,
      });
      tokens[role] = next;
      device.tokens = tokens;
      clearNodePairingGenerationState(device, previousNodeGeneration);
      return { value: next, patch: { tokens, nodeSurface: device.nodeSurface } };
    });
  }),
  "devicePairing.rotateToken": devicePairingMutation(function (
    params: {
      deviceId: string;
      role: string;
      scopes?: string[];
      callerScopes?: readonly string[];
      nowMs: number;
    },
    { recordRetiredNodeToken: onRetiredNodeToken },
  ): RotateDeviceTokenResult {
    const state = loadDevicePairingStateForMutation(params.nowMs);
    const context = resolveDeviceTokenUpdateContext({
      device: state.pairedByDeviceId[params.deviceId.trim()] ?? null,
      role: params.role,
    });
    if (!context) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const previousNodeGeneration = resolveNodePairingGeneration(device);
    const requestedScopes = normalizeDeviceAuthScopes(
      params.scopes ?? existing?.scopes ?? device.scopes,
    );
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (!approvedScopes) {
      return { ok: false, reason: "missing-approved-scope-baseline" };
    }
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return { ok: false, reason: "scope-outside-approved-baseline" };
    }
    if (params.callerScopes) {
      const missingScope = resolveMissingRequestedScope({
        role,
        requestedScopes,
        allowedScopes: params.callerScopes,
      });
      if (missingScope) {
        return { ok: false, reason: "caller-missing-scope", scope: missingScope };
      }
    }
    const now = params.nowMs;
    const next = createDeviceAuthToken({
      role,
      scopes: requestedScopes,
      existing,
      preserveExistingIssuer: true,
      now,
      rotatedAtMs: now,
    });
    tokens[role] = next;
    device.tokens = tokens;
    clearNodePairingGenerationState(device, previousNodeGeneration);
    state.pairedByDeviceId[device.deviceId] = device;
    const retiredNodeToken =
      role === "node" &&
      params.scopes !== undefined &&
      requestedScopes.length === 0 &&
      existing &&
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: existing.scopes,
        approvedScopes,
      })
        ? { deviceId: device.deviceId, expectedToken: existing.token }
        : undefined;
    persistState(state, undefined, "paired");
    if (retiredNodeToken) {
      onRetiredNodeToken?.(retiredNodeToken);
    }
    return { ok: true, entry: next };
  }),
  "devicePairing.revokeToken": devicePairingMutation(function (params: {
    deviceId: string;
    role: string;
    callerScopes?: readonly string[];
    nowMs: number;
  }): RevokeDeviceTokenResult {
    const state = loadDevicePairingStateForMutation(params.nowMs);
    const context = resolveDeviceTokenUpdateContext({
      device: state.pairedByDeviceId[params.deviceId.trim()] ?? null,
      role: params.role,
    });
    if (!context || !context.existing) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const previousNodeGeneration = resolveNodePairingGeneration(device);
    const targetScopes = normalizeDeviceAuthScopes(
      Array.isArray(existing.scopes) ? existing.scopes : device.scopes,
    );
    if (params.callerScopes) {
      const missingScope = resolveMissingRequestedScope({
        role,
        requestedScopes: targetScopes,
        allowedScopes: params.callerScopes,
      });
      if (missingScope) {
        return { ok: false, reason: "caller-missing-scope", scope: missingScope };
      }
    }
    const entry = { ...existing, revokedAtMs: params.nowMs };
    tokens[role] = entry;
    device.tokens = tokens;
    clearNodePairingGenerationState(device, previousNodeGeneration);
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, undefined, "paired");
    return { ok: true, entry };
  }),
} satisfies WorkerOperationHandlers;

function resolveDeviceTokenUpdateContext(params: { device: PairedDevice | null; role: string }): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = params.device;
  if (!device) {
    return null;
  }
  const role = normalizeDevicePairingRole(params.role);
  if (!role) {
    return null;
  }
  // Token issuance and rotation must stay inside the role set that pairing
  // approval recorded for this device.
  if (!listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }
  const tokens = { ...device.tokens };
  const existing = tokens[role];
  return { device, role, tokens, existing };
}
