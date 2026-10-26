import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isBoardSnapshot } from "../../lib/protocol-validators.generated/board.js";
import {
  isChatTranscriptMetadata,
  isMessageReactionSummary,
  isProgressCard,
} from "../../lib/protocol-validators.generated/transcript.js";
import * as json from "../../lib/snapshot-json.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";

const nonnegative = json.refine(json.number, (value) => value >= 0);
const sessionKeySchema = json.refine(json.text, (value) => value.length > 0);
const completePaginationSchema = json.object(
  {
    completeSnapshot: json.optional(json.literal(true)),
    hasMore: json.literal(false),
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const morePaginationSchema = json.object(
  {
    hasMore: json.literal(true),
    nextOffset: nonnegative,
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const paginationSchema = {
  parse(value: unknown) {
    return asOptionalRecord(value)?.hasMore === true
      ? morePaginationSchema.parse(value)
      : completePaginationSchema.parse(value);
  },
};
const snapshotSchema = json.object(
  {
    composer: json.optional(
      json.nullable(json.object({ id: json.text, provider: json.text, name: json.text })),
    ),
    board: json.optional(
      json.nullable(json.object({ snapshot: json.unknown, receivedAtMs: nonnegative }, true)),
    ),
    widgetHeights: json.optional(
      json.refine(
        json.record(json.refine(json.number, (height) => height >= 48 && height <= 8000)),
        (heights) => Object.keys(heights).length <= 100,
      ),
    ),
    transcriptMetadata: json.optional(json.checked(isChatTranscriptMetadata)),
    messageReactions: json.optional(
      json.record(json.array(json.checked(isMessageReactionSummary))),
    ),
    progressCard: json.optional(json.nullable(json.checked(isProgressCard))),
    deltaCursor: json.optional(json.text),
    // Only persisted warm metadata needs its full validator; read admission loads it below.
    historyState: json.optional(json.unknown),
    displayedLeafEntryId: json.optional(json.nullable(json.text)),
    // Message contents are opaque; only the array boundary needs validation.
    messages: json.checked<unknown[]>(Array.isArray),
    pagination: paginationSchema,
    sessionId: json.nullable(json.text),
  },
  true,
);
const recordSchema = json.refine(
  json.object(
    {
      projectionVersion: json.refine(
        json.number,
        (value) => Number.isSafeInteger(value) && value > 0,
      ),
      savedAt: nonnegative,
      sessionId: json.nullable(json.text),
      sessionKey: sessionKeySchema,
      snapshot: snapshotSchema,
    },
    true,
  ),
  (record) => record.sessionId === record.snapshot.sessionId,
);

export type SessionSnapshotRecord = Omit<json.SnapshotValue<typeof recordSchema>, "snapshot"> & {
  snapshot: ChatSessionSnapshot;
};

export async function parseSnapshotRecord(
  value: unknown,
  sessionKey?: string,
  onBoard?: (board: ChatSessionSnapshot["board"]) => void,
): Promise<SessionSnapshotRecord | null> {
  const parsed = json.parseSnapshot(recordSchema, value);
  if (!parsed || (sessionKey && parsed.sessionKey !== sessionKey)) {
    return null;
  }
  const { board: storedBoard, ...snapshot } = parsed.snapshot;
  // Cached display data is validated before any synchronous provider sees it.
  // A malformed board never invalidates an otherwise usable transcript.
  const board =
    storedBoard && isBoardSnapshot(storedBoard.snapshot)
      ? { snapshot: storedBoard.snapshot, receivedAtMs: storedBoard.receivedAtMs }
      : storedBoard == null
        ? storedBoard
        : undefined;
  const historyState = parsed.snapshot.historyState;
  if (historyState !== undefined) {
    // Do not hold board restoration behind the lazy transcript validator.
    onBoard?.(board);
    const { isChatHistoryState } =
      await import("../../lib/protocol-validators.generated/history-state.js");
    if (!isChatHistoryState(historyState)) {
      return null;
    }
  }
  return {
    ...parsed,
    snapshot: { ...snapshot, ...(board === undefined ? {} : { board }), historyState },
  };
}
