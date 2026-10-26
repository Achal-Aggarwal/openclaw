import { isDeepStrictEqual } from "node:util";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionEntryWindowFacts } from "./session-entry-window.types.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = Array<{
  entry: InternalSessionEntry;
  sessionKey: string;
  window?: SessionEntryWindowFacts;
  sideTables?: { memberIdsJson: string; hasBoard: boolean };
  row?: ResolvedSessionEntryRow["row"];
}>;

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const {
    participants: _leftParticipants,
    participantCount: _leftParticipantCount,
    ...leftEntry
  } = left;
  const {
    participants: _rightParticipants,
    participantCount: _rightParticipantCount,
    ...rightEntry
  } = right;
  // Participant history is a separately mutable SQLite projection. It must not
  // invalidate logical-session compare-and-swap or leak into entry_json writes.
  // Hydration and worker deltas can reorder keys without changing persisted values.
  return isDeepStrictEqual(leftEntry, rightEntry);
}

export function sqliteLifecycleTargetSnapshotsEqual(
  left: SqliteLifecycleTargetSnapshot,
  right: SqliteLifecycleTargetSnapshot,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

export function assertLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  if (!sqliteLifecycleTargetSnapshotsEqual(expected, current)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}
