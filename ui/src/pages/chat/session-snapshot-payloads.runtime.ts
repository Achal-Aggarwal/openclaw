import {
  isChatTranscriptMetadata,
  isMessageReactionSummary,
  isProgressCard,
} from "../../lib/protocol-validators.generated/transcript.js";
import * as json from "../../lib/snapshot-json.ts";

const payloadSchema = json.object({
  transcriptMetadata: json.optional(json.checked(isChatTranscriptMetadata)),
  messageReactions: json.optional(json.record(json.array(json.checked(isMessageReactionSummary)))),
  progressCard: json.optional(json.nullable(json.checked(isProgressCard))),
});

export function parseSnapshotPayloads(snapshot: unknown) {
  return json.parseSnapshot(payloadSchema, snapshot);
}
