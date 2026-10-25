import { loadStreamingMarkdown } from "../../components/markdown-live-loader.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { scopedAgentIdForSession } from "../../lib/sessions/index.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import type { QueuedChatSendOptions, QueuedChatSendResult } from "./chat-outbox-drain.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { resolveQueuedChatLeaf, waitForQueuedChatHistory } from "./chat-send-history.ts";
import { deliveryStateWriter } from "./chat-send-queue-write.ts";
import { surfaceChatDeliveryFailure } from "./chat-send-support.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";

export async function sendQueuedChatMessage(
  host: ChatHost,
  id: string,
  options?: QueuedChatSendOptions,
  queuedSessionKey = host.sessionKey,
  allowNativeRecovery = true,
): Promise<QueuedChatSendResult> {
  const storageMode = options?.storageMode ?? "durable";
  const connectionIsCurrent = captureChatConnectionOwner(host, false);
  let queued = readQueuedMessageById(host, id);
  const approvedReset = queued?.localCommandName === "reset" && Boolean(options?.target);
  if (!queued || queued.pendingRunId || (queued.localCommandName && !approvedReset)) {
    return "failed";
  }
  const retrySessionKey = queued.sessionKey ?? queuedSessionKey;
  const retryAgentId = queued.agentId;
  const retryOwnerIsCurrent = () => {
    if (!options?.canDispatch || options.canDispatch()) {
      return true;
    }
    deliveryStateWriter(host, storageMode, id)("failed", INTERRUPTED_SETTINGS_WAIT_ERROR);
    surfaceChatDeliveryFailure(
      host,
      retrySessionKey,
      retryAgentId,
      INTERRUPTED_SETTINGS_WAIT_ERROR,
    );
    return false;
  };
  if (!retryOwnerIsCurrent()) {
    return "failed";
  }
  let expectedLeafEntryId = resolveQueuedChatLeaf(host, queued, options);
  const history = queued.sendAttempts
    ? undefined
    : waitForQueuedChatHistory(host, queued, queuedSessionKey, options);
  if (history) {
    const ready = await history;
    if (!retryOwnerIsCurrent()) {
      return "failed";
    }
    if (!ready) {
      return "pending";
    }
    ({ item: queued, expectedLeafEntryId } = ready);
  }
  // FIFO and visible history are admitted before preparing transport and the first reply.
  const { sendPreparedChatQueueItem: sendPrepared, error: preparationError } = await Promise.all([
    import("./chat-send-delivery.runtime.ts").then(
      ({ sendPreparedChatQueueItem }) => sendPreparedChatQueueItem,
    ),
    loadStreamingMarkdown(),
  ]).then(
    ([sendPreparedChatQueueItem]) => ({ sendPreparedChatQueueItem, error: undefined }),
    (error: unknown) => ({ sendPreparedChatQueueItem: undefined, error }),
  );
  if (!connectionIsCurrent()) {
    return "pending";
  }
  const current = readQueuedMessageById(host, id);
  if (!current || !sameQueuedDeliveryVersion(current, queued)) {
    return "pending";
  }
  if (!retryOwnerIsCurrent()) {
    return "failed";
  }
  if (!sendPrepared) {
    const error = formatUiError(preparationError);
    deliveryStateWriter(host, storageMode, id)("failed", error);
    surfaceChatDeliveryFailure(host, retrySessionKey, retryAgentId, error);
    return "failed";
  }
  return sendPrepared(
    host,
    current,
    expectedLeafEntryId,
    options,
    queuedSessionKey,
    allowNativeRecovery,
    retryOwnerIsCurrent,
  );
}

export async function deliverChatQueueItem(
  host: ChatHost,
  item: ChatQueueItem,
  options: QueuedChatSendOptions = {},
): Promise<QueuedChatSendResult> {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const routingSessionKey = options.routingSessionKey ?? sessionKey;
  const storageMode = options.storageMode ?? "durable";
  const connectionIsCurrent = captureChatConnectionOwner(host, false);
  const agentId = item.agentId ?? scopedAgentIdForSession(host, routingSessionKey);
  const sendOptions = {
    ...options,
    routingSessionKey,
    storageMode,
    pendingSettings: item.localCommandName
      ? undefined
      : (options.pendingSettings ??
        getPendingChatPickerPatch(host, routingSessionKey, item.agentId)),
  };
  // The caller already transferred composer custody to this exact outbox row.
  // Loading execution must not retarget a replacement row or connection.
  try {
    const { deliverAdmittedChatQueueItem } = await import("./chat-send-delivery.runtime.ts");
    const current = readQueuedMessageById(host, item.id);
    if (!connectionIsCurrent() || !current || !sameQueuedDeliveryVersion(current, item)) {
      return "pending";
    }
    return deliverAdmittedChatQueueItem(host, current, sendOptions, connectionIsCurrent, agentId);
  } catch (error) {
    const current = readQueuedMessageById(host, item.id);
    if (connectionIsCurrent() && current && sameQueuedDeliveryVersion(current, item)) {
      const message = formatUiError(error);
      deliveryStateWriter(host, storageMode, item.id)("failed", message);
      surfaceChatDeliveryFailure(host, sessionKey, agentId, message);
      return "failed";
    }
    return "pending";
  }
}
