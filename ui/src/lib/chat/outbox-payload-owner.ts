import { readOfflineStorageScope, type OfflineStorageClient } from "../../app/boot-record.ts";
import type { ChatQueueItem } from "./chat-types.ts";

type RecoveryHost = {
  client?: OfflineStorageClient | null;
  connected?: boolean;
  settings?: { gatewayUrl?: string | null };
};

export function outboxStorageScope(host: RecoveryHost): string | undefined {
  const owner = readOfflineStorageScope(host);
  return owner
    ? JSON.stringify([host.settings?.gatewayUrl?.trim() || "default", owner])
    : undefined;
}

/** Explicit legacy review may assign unowned input, but never another account's input. */
export function outboxPayloadCanRecover(host: RecoveryHost, item: ChatQueueItem): boolean {
  return (
    (!item.storageScope || item.storageScope === outboxStorageScope(host)) &&
    (!item.attachmentPayload ||
      item.attachmentPayload.recoveryScope === readOfflineStorageScope(host))
  );
}

/** Normal projection and delivery require provenance captured by an admission owner. */
export function outboxPayloadMatchesOwner(host: RecoveryHost, item: ChatQueueItem): boolean {
  return Boolean(item.storageScope && outboxPayloadCanRecover(host, item));
}
