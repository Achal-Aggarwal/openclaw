import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readChatToolFamily } from "../../lib/chat/tool-family.ts";
import { hasToolMessageDemand } from "../../lib/chat/tool-message-demand.ts";
import type { PendingSessionsYield } from "./chat-sessions-yield.runtime.ts";

export type { PendingSessionsYield } from "./chat-sessions-yield.runtime.ts";

/** Keep handoff-capable calls and results until the projection can pair them. */
export function hasHandoffToolCall(message: unknown): boolean {
  return hasToolMessageDemand(message) && readChatToolFamily().hasHandoffToolCall(message);
}

function isTurnStatus(item: ChatItem): item is Extract<ChatItem, { kind: "reading-indicator" }> {
  return item.kind === "reading-indicator";
}

/**
 * Keeps private yield calls out of tool details and separates a resumed run from the
 * run that handed off. Message waits retain their public acknowledgment/status;
 * child waits use the working indicator.
 *
 * `complete` is this projection of the same transcript before search hid any
 * rows. A resumed run's request and handoffs are facts of the whole transcript,
 * so working and waiting statuses are taken from there, not from the matching rows.
 */
export function projectSessionsYieldItems(
  items: ChatItem[],
  showToolCalls = true,
  complete?: readonly ChatItem[],
): ChatItem[] {
  const projected = items.some(
    (item) => item.kind === "message" && hasToolMessageDemand(item.message),
  )
    ? readChatToolFamily().scanSessionsYieldItems(items, showToolCalls).items
    : items;
  const status = complete?.find(isTurnStatus);
  const completeKeys = complete && new Set(complete.map((item) => item.key));
  const visible = completeKeys
    ? projected.filter(
        (item) => !item.key.startsWith("yield-status:") || completeKeys.has(item.key),
      )
    : projected;
  return status
    ? visible.map((item) => (isTurnStatus(item) && item.key === status.key ? status : item))
    : visible;
}

/** Reuse the tool pairing owner for separate results and bundled nested calls. */
export function pendingSessionsYield(messages: readonly unknown[]): PendingSessionsYield | null {
  return messages.some(hasToolMessageDemand)
    ? readChatToolFamily().pendingSessionsYield(messages)
    : null;
}
