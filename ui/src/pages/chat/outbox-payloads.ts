import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { OutboxPayloadFailure } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { removeRetiredOutboxPayloads } from "../../lib/chat/outbox-store-payload-retirement.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import type { ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";

export type Host = ChatComposerScope & { sessionKey?: string };
type PayloadUpdate = Pick<ChatQueueItem, "attachments" | "attachmentPayload"> & {
  attachmentStorageError?: undefined;
};
export type PayloadResult =
  | { status: "ready"; update: PayloadUpdate }
  | { status: "failed"; reason: OutboxPayloadFailure };

export function outboxPayloadError(reason: OutboxPayloadFailure): string {
  return t(
    `chat.sendErrors.outboxPayload${reason === "capacity" ? "Capacity" : reason === "missing" ? "Missing" : "Unavailable"}`,
  );
}

export function failOutboxPayload(item: ChatQueueItem, reason: OutboxPayloadFailure) {
  const awaitingDelivery =
    item.sendState !== "failed" &&
    ((item.sendAttempts ?? 0) > 0 || item.sendRequestStartedAtMs !== undefined);
  return {
    ...item,
    attachmentStorageError: reason,
    // Missing local bytes cannot settle an earlier transport attempt or release its FIFO slot.
    sendState:
      item.sendState === "held" || awaitingDelivery ? ("held" as const) : ("failed" as const),
    sendError: outboxPayloadError(reason),
  };
}

function payloadScope(host: Host, item?: ChatQueueItem) {
  return resolveUiConversationIdentity(
    host,
    item?.sessionKey ?? host.sessionKey ?? "",
    item?.agentId,
  );
}

export function captureOutboxPayloadOwner(
  host: Host,
  scope: StoredChatOutboxScope = payloadScope(host),
): () => boolean {
  const client = host.client;
  const gateway = host.settings?.gatewayUrl;
  const recoveryScope = readOfflineStorageScope(host);
  const incognito = isIncognitoComposerScope(host, scope);
  return () =>
    host.client === client &&
    host.settings?.gatewayUrl === gateway &&
    readOfflineStorageScope(host) === recoveryScope &&
    isIncognitoComposerScope(host, scope) === incognito;
}

export async function prepareOutboxPayload(
  host: Host,
  item: ChatQueueItem,
  purpose: "send" | "handoff" = "send",
): Promise<PayloadResult> {
  if (!item.attachments?.length && !item.attachmentPayload && !item.attachmentStorageError) {
    return { status: "ready", update: {} };
  }
  const scope = payloadScope(host, item);
  if (isIncognitoComposerScope(host, scope)) {
    return item.attachmentPayload
      ? { status: "failed", reason: "unavailable" }
      : { status: "ready", update: {} };
  }
  const recoveryScope = readOfflineStorageScope(host);
  if (!recoveryScope) {
    return { status: "failed", reason: "unavailable" };
  }
  const isCurrent = captureOutboxPayloadOwner(host, scope);
  try {
    const { prepareOutboxPayload } = await import("./outbox-payloads.runtime.ts");
    return isCurrent()
      ? prepareOutboxPayload(host, item, purpose, { scope, recoveryScope, isCurrent })
      : { status: "failed", reason: "unavailable" };
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
}

export function retireOutboxPayload(item: Pick<ChatQueueItem, "attachmentPayload">): void {
  if (item.attachmentPayload) {
    removeRetiredOutboxPayloads([item.attachmentPayload]);
  }
}
