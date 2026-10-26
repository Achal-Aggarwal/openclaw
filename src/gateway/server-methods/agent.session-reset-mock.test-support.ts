import type { SessionEntry } from "../../config/sessions.js";
import type { ResetSessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.lifecycle-types.js";
import type { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";

type UpdateSessionStore = (
  storePath: string,
  update: (store: Record<string, SessionEntry>) => Promise<SessionEntry>,
) => Promise<unknown>;

export function createSessionResetFixture(
  updateSessionStore: UpdateSessionStore,
): typeof resetSessionEntryLifecycle {
  return async (params) => {
    let mutation: ResetSessionEntryLifecycleMutation | undefined;
    await updateSessionStore(params.storePath, async (store) => {
      params.commitGuard?.();
      const previousEntry = store[params.target.canonicalKey];
      const nextEntry = await params.buildNextEntry({
        currentEntry: previousEntry ? structuredClone(previousEntry) : undefined,
        primaryKey: params.target.canonicalKey,
      });
      params.commitGuard?.();
      store[params.target.canonicalKey] = nextEntry;
      mutation = { nextEntry, previousEntry, previousSessionId: previousEntry?.sessionId };
      return nextEntry;
    });
    if (!mutation) {
      throw new Error("Reset fixture did not commit a session entry");
    }
    await params.afterEntryMutation?.(mutation, {
      env: {},
      source: { agentId: params.agentId ?? "main", path: params.storePath },
      assertCurrent: () => params.commitGuard?.(),
    });
    return { ...mutation, archivedTranscripts: [] };
  };
}
