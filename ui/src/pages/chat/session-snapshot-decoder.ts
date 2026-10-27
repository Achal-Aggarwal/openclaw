import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import * as json from "../../lib/snapshot-json.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import { prepareSnapshotPayloadValidators } from "./session-snapshot-payloads.ts";
import {
  loadChatHistoryStateValidator,
  prewarmedHistoryStateValidator,
} from "./session-snapshot-prewarm.ts";

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
const permissionModeSchema = json.enumeration(["read-only", "guarded", "workspace", "full"]);
const snapshotSchema = json.object(
  {
    composer: json.optional(
      json.nullable(
        json.object({
          id: json.text,
          provider: json.text,
          name: json.text,
          reasoning: json.optional(json.boolean),
          speed: json.optional(
            json.object({
              active: json.boolean,
              currentOverride: json.enumeration(["", "on", "off", "auto", "ultrafast"]),
              label: json.text,
              supported: json.boolean,
            }),
          ),
          thinkingLevel: json.optional(json.text),
          thinkingDefault: json.optional(json.text),
          thinkingLevels: json.optional(
            json.array(json.object({ id: json.text, label: json.text }), 30),
          ),
          permissionMode: json.optional(permissionModeSchema),
          defaultPermissionMode: json.optional(permissionModeSchema),
        }),
      ),
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
    // Optional payloads pass their canonical readers below, before publication.
    transcriptMetadata: json.optional(json.unknown),
    messageReactions: json.optional(json.unknown),
    progressCard: json.optional(json.unknown),
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
  const {
    board: storedBoard,
    transcriptMetadata: _transcriptMetadata,
    messageReactions: _messageReactions,
    progressCard: _progressCard,
    ...snapshot
  } = parsed.snapshot;
  const validators = prepareSnapshotPayloadValidators(parsed.snapshot);
  if (validators.pending) {
    await validators.pending;
  }
  const transcriptFields = validators.loaded.transcript
    ? validators.loaded.transcript(parsed.snapshot)
    : {};
  if (!transcriptFields) {
    return null;
  }
  // Cached display data is validated before any synchronous provider sees it.
  // A malformed board never invalidates an otherwise usable transcript.
  const board =
    storedBoard && validators.loaded.board?.(storedBoard.snapshot)
      ? { snapshot: storedBoard.snapshot, receivedAtMs: storedBoard.receivedAtMs }
      : storedBoard == null
        ? storedBoard
        : undefined;
  const historyState = parsed.snapshot.historyState;
  if (historyState !== undefined) {
    // Do not hold board restoration behind the lazy transcript validator.
    onBoard?.(board);
    // Reuse the validated warm-start path without another async import turn.
    const isChatHistoryState =
      prewarmedHistoryStateValidator ?? (await loadChatHistoryStateValidator());
    if (!isChatHistoryState(historyState)) {
      return null;
    }
  }
  return {
    ...parsed,
    snapshot: {
      ...snapshot,
      ...transcriptFields,
      ...(board === undefined ? {} : { board }),
      historyState,
    },
  };
}
