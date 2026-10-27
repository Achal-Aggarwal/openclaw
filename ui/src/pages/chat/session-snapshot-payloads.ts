/** Starts code loading only; callers retain validation and publication authority. */
export function prepareSnapshotPayloadValidators(snapshot: Record<string, unknown>) {
  return {
    board: snapshot.board ? import("../../lib/protocol-validators.generated/board.js") : undefined,
    transcript:
      "transcriptMetadata" in snapshot ||
      "messageReactions" in snapshot ||
      "progressCard" in snapshot
        ? import("./session-snapshot-payloads.runtime.ts")
        : undefined,
  };
}
