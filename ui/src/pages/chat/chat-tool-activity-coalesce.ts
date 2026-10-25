// Keep turn boundaries and caller-wrapper ownership independent of tool rendering.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping, resolveMessageRole } from "../../lib/chat/message-metadata.ts";
import { readChatToolFamily } from "../../lib/chat/tool-family.ts";
import { hasToolMessageDemand } from "../../lib/chat/tool-message-demand.ts";
import { chatItemStartsDisplayTurn } from "./chat-turn-boundary.ts";

type CachedTurn = { inputs: unknown[]; items: ChatItem[] };
// Interleaved transcript builds share the cache without evicting other owners.
const turnsByOwner = new WeakMap<object, CachedTurn>();

function coalesceTurn(items: ChatItem[]): ChatItem[] {
  return items.some((item) => item.kind === "message" && hasToolMessageDemand(item.message))
    ? readChatToolFamily().coalesceToolActivityTurn(items)
    : items;
}

export function coalesceToolActivityMessages(
  items: ChatItem[],
  hiddenKeys?: ReadonlySet<string>,
): ChatItem[] {
  return coalesceToolActivityTurns(items, hiddenKeys, coalesceTurn);
}

/** The deferred handoff reader reuses the same turn/cache owner with its loaded parser. */
export function coalesceToolActivityTurns(
  items: ChatItem[],
  hiddenKeys: ReadonlySet<string> | undefined,
  coalesceTurn: (items: ChatItem[]) => ChatItem[],
): ChatItem[] {
  const result: ChatItem[] = [];
  const appendTurn = (turn: ChatItem[]) => {
    if (turn.length === 0) {
      return;
    }
    const inputs: unknown[] = [];
    let owner: object | undefined;
    for (const item of turn) {
      const message = item.kind === "message" ? asRecord(item.message) : null;
      // Transient wrappers carry independently changing stream/attribution facts.
      if (item.kind !== "message" || !message || message["__openclawToolStreamLive"] === true) {
        result.push(...coalesceTurn(turn));
        return;
      }
      owner ??= message;
      inputs.push(item.kind, item.key, message, item.duplicateCount, item.startsTurn);
      // Preserve the content-replacement contract of the tool-card owner too.
      inputs.push(message.content);
      if (Array.isArray(message.content)) {
        inputs.push(...message.content);
      }
    }
    const cached = turnsByOwner.get(owner!);
    const entry =
      cached?.inputs.length === inputs.length &&
      inputs.every((input, index) => input === cached.inputs[index])
        ? cached
        : // coalesceTurn can return caller wrappers; store copies so later annotations stay out.
          { inputs, items: coalesceTurn(turn).map((item) => Object.assign({}, item)) };
    turnsByOwner.set(owner!, entry);
    // Grouping annotates wrappers, so stored wrappers are never returned.
    for (const item of entry.items) {
      result.push({ ...item });
    }
  };
  let turn: ChatItem[] = [];
  for (const item of items) {
    const boundary = chatItemStartsDisplayTurn(item) || item.kind === "divider";
    if (boundary) {
      appendTurn(turn);
      turn = [];
    }
    // Hidden rows still delimit turns: reused call ids must never pair across
    // a prompt or forwarded input removed by transcript search.
    if (hiddenKeys?.has(item.key)) {
      continue;
    }
    if (
      boundary &&
      (item.kind !== "message" ||
        normalizeRoleForGrouping(resolveMessageRole(item.message)) === "user")
    ) {
      result.push(item);
      continue;
    }
    // A projected output starts the new turn and still owns its tool calls.
    turn.push(item);
  }
  appendTurn(turn);
  return result;
}
