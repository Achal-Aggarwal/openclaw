import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { getChatHistoryLoadState, isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { QueuedChatSendOptions } from "./chat-outbox-drain.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";

export function resolveQueuedChatLeaf(
  host: ChatHost,
  item: ChatQueueItem,
  options?: QueuedChatSendOptions,
): string | null | undefined {
  if (options?.expectedLeafEntryId !== undefined) {
    return options.expectedLeafEntryId;
  }
  return options?.routingSessionKey &&
    visibleSessionMatches(host, item.sessionKey ?? host.sessionKey, item.agentId)
    ? resolveDisplayedLeafEntryId(host)
    : undefined;
}

export function waitForQueuedChatHistory(
  host: ChatHost,
  item: ChatQueueItem,
  queuedSessionKey: string,
  options?: QueuedChatSendOptions,
):
  | Promise<{ item: ChatQueueItem; expectedLeafEntryId: string | null | undefined } | null>
  | undefined {
  const sessionKey = item.sessionKey ?? queuedSessionKey;
  if (
    !host.connected ||
    !host.client ||
    !visibleSessionMatches(host, sessionKey, item.agentId) ||
    (!host.chatLoading && !isInitialChatHistoryUnavailable(host))
  ) {
    return undefined;
  }
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const sessions = host.sessions;
  const history = getChatHistoryLoadState(host);
  // Background outbox wakeups cannot take over the transcript's visible Retry action.
  if (history.phase === "failed") {
    return Promise.resolve(null);
  }
  // The outbox already owns the draft. Join startup before reusing cached
  // session/branch identity, without issuing a competing history request.
  const loading =
    history.phase === "in-flight"
      ? history.promise
      : loadChatHistory(host, {
          startup: isInitialChatHistoryUnavailable(host),
          deferBranches: true,
        });
  return loading.then((loaded) => {
    const current = readQueuedMessageById(host, item.id);
    if (
      !loaded ||
      !connectionIsCurrent() ||
      host.sessions !== sessions ||
      !visibleSessionMatches(host, sessionKey, item.agentId) ||
      !current ||
      !sameQueuedDeliveryVersion(current, item) ||
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      return null;
    }
    return { item: current, expectedLeafEntryId: resolveQueuedChatLeaf(host, current, options) };
  });
}
