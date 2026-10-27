type SnapshotPayloadValidators = {
  board?: typeof import("../../lib/protocol-validators.generated/board.js").isBoardSnapshot;
  transcript?: typeof import("./session-snapshot-payloads.runtime.ts").parseSnapshotPayloads;
};

// Function receipts are process-wide; snapshot data and validation stay with the caller.
const loaded: SnapshotPayloadValidators = {};

async function loadBoardSnapshotValidator() {
  const { isBoardSnapshot } = await import("../../lib/protocol-validators.generated/board.js");
  loaded.board = isBoardSnapshot;
}

async function loadTranscriptPayloadParser() {
  const { parseSnapshotPayloads } = await import("./session-snapshot-payloads.runtime.ts");
  loaded.transcript = parseSnapshotPayloads;
}

/** Starts code loading only; callers retain validation and publication authority. */
export function prepareSnapshotPayloadValidators(snapshot: Record<string, unknown>) {
  const pending: Promise<void>[] = [];
  if (snapshot.board && !loaded.board) {
    pending.push(loadBoardSnapshotValidator());
  }
  if (
    !loaded.transcript &&
    ("transcriptMetadata" in snapshot ||
      "messageReactions" in snapshot ||
      "progressCard" in snapshot)
  ) {
    pending.push(loadTranscriptPayloadParser());
  }
  return { loaded, pending: pending.length ? Promise.all(pending) : undefined };
}
