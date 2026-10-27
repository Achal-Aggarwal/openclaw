import { snapshotStoreGeneration } from "./session-snapshot-invalidation-events.ts";

/** Each store owns its readers; retiring a key cannot revive an earlier read. */
export function captureSnapshotReadScope(
  scopes: Map<string, { readers: number }>,
  sessionKey: string,
): { isCurrent: () => boolean; dispose: () => void } {
  const generation = snapshotStoreGeneration;
  const entry = scopes.get(sessionKey) ?? { readers: 0 };
  scopes.set(sessionKey, entry);
  entry.readers += 1;
  let disposed = false;
  return {
    isCurrent: () =>
      !disposed && generation === snapshotStoreGeneration && scopes.get(sessionKey) === entry,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      entry.readers -= 1;
      if (entry.readers === 0 && scopes.get(sessionKey) === entry) {
        scopes.delete(sessionKey);
      }
    },
  };
}
