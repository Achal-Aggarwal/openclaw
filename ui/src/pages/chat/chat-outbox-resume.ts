import type { GatewayEventFrame } from "../../api/gateway.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { flushStoredChatOutbox, resumeStoredChatOutboxes as resume } from "./chat-outbox-drain.ts";
import { collectChatOutboxes } from "./chat-outbox-scopes.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies } from "./chat-send-delivery.ts";

export async function resumeStoredChatOutboxes(host: ChatHost, event?: GatewayEventFrame) {
  if (!host.connected || !host.client || collectChatOutboxes(host, event).length === 0) {
    return;
  }
  await resume(host, chatOutboxDrainDependencies, event);
}

export async function flushChatQueueForEvent(host: ChatHost) {
  if (
    !listStoredChatOutboxes(host).some((outbox) =>
      visibleSessionMatches(host, outbox.sessionKey, outbox.agentId),
    )
  ) {
    return;
  }
  await flushStoredChatOutbox(host, chatOutboxDrainDependencies);
}
