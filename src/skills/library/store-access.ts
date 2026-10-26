import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStatePathCacheInvalidation } from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  captureUserProfileAuthorityRead,
  readUserProfileVersion,
} from "../../state/user-profile-events.js";
import {
  hasMultipleResidentSessionSharingIdentities,
  readResidentUserProfileIdentity,
} from "../../state/user-profile-list.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type {
  SkillLibraryReadInput,
  SkillLibraryReadQueries,
  SkillLibraryReadOutput,
  SkillLibraryWorkerAuthority,
} from "./read.contract.js";
import type { SkillLibraryAuthority } from "./store.js";
import type { SkillLibraryWorkerOperations } from "./store.worker-contract.js";

type CachedReply = SkillLibraryReadOutput & { ok: true };
type CachedRead = {
  value: CachedReply;
  profileVersion: number;
  profilesCurrent: () => boolean;
};
type Store = {
  path: string;
  revision: object;
  pending: number;
  reads: Map<string, CachedRead>;
};
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.skillLibraryAuthority"),
  "close-and-restart",
);
registerOpenClawStatePathCacheInvalidation(stores);
function owner(admission: OpenClawStateDatabaseReadAdmission) {
  admission.assertCurrent();
  let store = stores.get(admission.coordinationKey);
  if (!store) {
    store = { path: admission.identity.canonicalPath, revision: {}, pending: 0, reads: new Map() };
    stores.set(admission.coordinationKey, store);
  }
  return store;
}

/** Read facts and prepared selections share the owning writer's committed revision. */
function captureSkillLibraryAuthorityRead(admission: OpenClawStateDatabaseReadAdmission) {
  const store = owner(admission);
  const revision = store.revision;
  const profileVersion = readUserProfileVersion();
  const assertCurrent = () => {
    admission.assertCurrent();
    if (
      stores.get(admission.coordinationKey) !== store ||
      store.revision !== revision ||
      store.pending
    ) {
      throw new SkillLibraryError(
        "CONFLICT",
        "Skill library access changed during preparation. Refresh and retry.",
      );
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    read(key: string): CachedReply | undefined {
      assertCurrent();
      const cached = store.reads.get(key);
      if (!cached) {
        return undefined;
      }
      if (cached.profileVersion !== readUserProfileVersion() || !cached.profilesCurrent()) {
        store.reads.delete(key);
        return undefined;
      }
      return structuredClone(cached.value);
    },
    remember(key: string, value: CachedReply, profilesCurrent: () => boolean): void {
      assertCurrent();
      if (profileVersion !== readUserProfileVersion()) {
        return;
      }
      // Bound arbitrary query parameters and retain caller-owned result objects.
      if (store.reads.size >= 128) {
        store.reads.delete(store.reads.keys().next().value!);
      }
      store.reads.set(key, {
        value: structuredClone(value),
        profileVersion,
        profilesCurrent,
      });
    },
  };
}

/** Fence before granting COMMIT; publish inside the writer FIFO after native settlement. */
function fenceSkillLibraryMutationAuthority(admission: OpenClawStateDatabaseReadAdmission) {
  const store = owner(admission);
  store.pending += 1;
  let settled = false;
  return (outcome: "committed" | "rolled-back" | "unknown") => {
    if (settled) {
      return;
    }
    settled = true;
    store.pending -= 1;
    // Only a confirmed rollback preserves an earlier prepared selection.
    if (outcome !== "rolled-back") {
      store.revision = {};
      store.reads.clear();
    }
  };
}

/** Capture the original physical store and host policy before filesystem or worker waits. */
export function captureSkillLibraryAccess(
  authority: SkillLibraryAuthority,
  options: OpenClawStateDatabaseOptions = {},
) {
  authority.assertCurrent();
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({
    path: options.database?.path ?? options.path,
    env,
  });
  const roles = structuredClone(authority.getConfig().gateway?.roles);
  const input: SkillLibraryWorkerAuthority = {
    profileId: authority.profileId,
    namespace: authority.namespace,
    scopes: [...authority.scopes],
    config: { gateway: { roles } },
  };
  const pinned = { path: context.admission.databasePath, env: { ...env, ...context.environment } };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    authority.assertCurrent();
    if (
      !isDeepStrictEqual(roles, authority.getConfig().gateway?.roles) ||
      !isDeepStrictEqual(input.scopes, authority.scopes) ||
      input.profileId !== authority.profileId ||
      input.namespace !== authority.namespace
    ) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Skill library authority changed. Refresh and retry.",
      );
    }
  };
  return {
    options: pinned,
    assertCurrent,
    async read<K extends keyof SkillLibraryReadQueries>(
      kind: K,
      params: SkillLibraryReadQueries[K]["input"],
    ) {
      assertCurrent();
      const library = captureSkillLibraryAuthorityRead(context.admission);
      const assertSource = () => {
        assertCurrent();
        library.assertCurrent();
      };
      const profiles = await captureUserProfileAuthorityRead(context.admission);
      assertSource();
      const commandInput = {
        kind,
        params,
        authority: input,
        ...(kind === "session" ? { sessionFacts: captureSessionFacts() } : {}),
      } as SkillLibraryReadInput; // SAFETY: K binds the captured kind and parameters in SkillLibraryReadQueries.
      // Upload progress changes independently of published library entries.
      const cacheKey = kind === "upload" ? undefined : JSON.stringify(commandInput);
      const cached = cacheKey === undefined ? undefined : library.read(cacheKey);
      const reply =
        cached ??
        (await executeExistingOpenClawStateRead(
          pinned,
          { type: "skillLibrary.read", input: commandInput },
          { context, current: true },
        ));
      assertSource();
      if (!reply) {
        if (kind !== "seed") {
          throw new SkillLibraryError("NOT_FOUND", "Skill library is unavailable.");
        }
        // SAFETY: A missing store has no default selections; this branch has the seed query kind.
        const value = [] as SkillLibraryReadQueries[K]["output"];
        return { value, assertCurrent: assertSource };
      }
      if (!reply.ok || reply.type !== "skillLibrary.read" || reply.kind !== kind) {
        throw new Error("Unexpected skill library read result");
      }
      const profileCurrent = profiles.bind(reply.profileIds);
      if (!profileCurrent) {
        throw new SkillLibraryError(
          "CONFLICT",
          "Profile authority changed during library access. Retry.",
        );
      }
      const check = () => {
        assertSource();
        if (!profileCurrent()) {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Skill library profile authority changed. Refresh and retry.",
          );
        }
      };
      check();
      if (cacheKey !== undefined && !cached) {
        library.remember(cacheKey, reply, profileCurrent);
      }
      // SAFETY: The typed read registry binds output to kind, checked against K above.
      const value = reply.value as SkillLibraryReadQueries[K]["output"];
      return { value, assertCurrent: check };
    },
    async write<K extends keyof SkillLibraryWorkerOperations>(
      type: K,
      params: Omit<SkillLibraryWorkerOperations[K]["input"], "authority">,
    ): Promise<SkillLibraryWorkerOperations[K]["output"]> {
      assertCurrent();
      const command = {
        type,
        input: {
          ...params,
          authority: input,
        } as SkillLibraryWorkerOperations[K]["input"], // SAFETY: K binds this input to the registry operation.
      };
      let admission: SqliteWorkerOperationAdmission | undefined;
      let publication: Promise<void> | undefined;
      let prepared: unknown;
      try {
        return await runOpenClawStateWorkerOperation(
          context,
          async (scope) => {
            try {
              return await scope.execute(command);
            } catch (error) {
              await publication;
              if (admission?.committed && isDeepStrictEqual(admission.committed.facts, prepared)) {
                // SAFETY: The native receipt certifies this typed command's exact provisional result.
                return prepared as SkillLibraryWorkerOperations[K]["output"];
              }
              throw error;
            } finally {
              // Revision publication precedes releasing the physical writer's FIFO.
              await publication;
            }
          },
          {
            assertCurrent,
            createAdmission(operation) {
              let stage: "transaction" | "commit" = "transaction";
              let settle: ReturnType<typeof fenceSkillLibraryMutationAuthority> | undefined;
              let granted = false;
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                assertCurrent();
                if (request.stage !== stage) {
                  throw new Error("Unexpected skill library write admission");
                }
                if (stage === "transaction") {
                  stage = "commit";
                } else {
                  stage = "transaction";
                  prepared = request.facts;
                  if (
                    type !== "skillLibrary.upload" &&
                    isRecord(request.facts) &&
                    request.facts.state !== "unchanged"
                  ) {
                    settle = fenceSkillLibraryMutationAuthority(context.admission);
                  }
                }
                const accepted = grant();
                if (request.stage === "commit") {
                  granted = accepted;
                }
              });
              const accepted = admission;
              publication = operation.settled.then((outcome) => {
                const committed =
                  accepted.committed && isDeepStrictEqual(accepted.committed.facts, prepared);
                settle?.(
                  committed
                    ? "committed"
                    : !granted || outcome.kind === "completed"
                      ? "rolled-back"
                      : "unknown",
                );
              });
              return { admission, nativeLocations: [pinned.path] };
            },
          },
        );
      } finally {
        await publication;
      }
    },
  };

  function captureSessionFacts() {
    const profile = input.profileId
      ? readResidentUserProfileIdentity(input.profileId, pinned)
      : undefined;
    if (input.profileId && !profile) {
      throw new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Your Gateway profile is no longer available. Sign in again before accessing the library.",
      );
    }
    return {
      profile: profile
        ? { id: profile.profileId, role: profile.role, githubLogin: profile.githubLogin ?? null }
        : undefined,
      multipleProfiles: hasMultipleResidentSessionSharingIdentities(pinned),
    };
  }
}
