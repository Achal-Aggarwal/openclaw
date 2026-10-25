import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { QueuedChatStorageMode } from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { updateQueuedMessage } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";

export function updateQueuedSendItem(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return storageMode === "memory"
    ? chatOutboxOwner(host).change(host, id, update, true)
    : updateQueuedMessage(host, id, update);
}

export function deliveryStateWriter(
  host: ChatHost,
  storageMode: QueuedChatStorageMode,
  id: string,
) {
  return (sendState: ChatQueueItem["sendState"], sendError?: string) =>
    updateQueuedSendItem(host, storageMode, id, (item) =>
      item.sendState === "held" ? item : { ...item, sendError, sendState },
    );
}
