// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.ts";
import { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { readQueuedMessageById, removeQueuedMessage, updateQueuedMessage } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
afterEach(() => vi.doUnmock("./chat-send-delivery.runtime.ts"));

it("admits the canonical row before a failed delivery import and retains it for retry", async () => {
  // mock-isolation: Fail code loading without replacing admission, persistence or transport.
  vi.doMock("./chat-send-delivery.runtime.ts", () => {
    throw new Error("Synthetic delivery module unavailable");
  });
  const host = makeChatHost({ chatMessage: "Keep my submitted prompt", requestHandlers: {} });
  const admitted = vi.fn();
  const sending = handleSendChat(host, undefined, { onOutboxAdmitted: admitted });
  const stored = listStoredChatOutboxes(host)[0]?.queue[0];
  expect(stored).toMatchObject({ text: "Keep my submitted prompt", sendAttempts: 0 });
  expect(host.chatMessage).toBe("");
  expect(admitted).toHaveBeenCalledOnce();
  host.chatMessage = "A newer draft";
  try {
    await expect(sending).resolves.toBe(false);
    expect(readQueuedMessageById(host, stored!.id)).toMatchObject({
      text: "Keep my submitted prompt",
      sendState: "failed",
      sendError: expect.stringContaining("Synthetic delivery module unavailable"),
      sendAttempts: 0,
    });
    expect(host.chatMessage).toBe("A newer draft");
    expect(host.chatError).toContain("Synthetic delivery module unavailable");
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
  } finally {
    host.sessions.dispose();
  }
});

it("keeps consecutive admissions synchronous and respects removal while delivery loads", async () => {
  const started = createDeferred();
  const release = createDeferred();
  // mock-isolation: Hold the real execution module after the outbox owns both rows.
  vi.doMock(import("./chat-send-delivery.runtime.ts"), async (importOriginal) => {
    started.resolve();
    await release.promise;
    return importOriginal();
  });
  const host = makeChatHost({
    chatMessage: "First prompt",
    requestHandlers: { "chat.send": { status: "ok", messageSeq: 1 } },
  });
  const admitted = vi.fn();
  const first = handleSendChat(host, undefined, { onOutboxAdmitted: admitted });
  host.chatMessage = "Second prompt";
  const second = handleSendChat(host, undefined, { onOutboxAdmitted: admitted });
  expect(admitted).toHaveBeenCalledTimes(2);
  const stored = listStoredChatOutboxes(host)[0]?.queue ?? [];
  expect(stored.map((row) => row.text)).toEqual(["First prompt", "Second prompt"]);
  expect(host.chatMessage).toBe("");
  host.chatMessage = "Unsubmitted third prompt";
  try {
    await awaitGateBeforeSettlement(started.promise, first, "Delivery import was bypassed");
    expect(requestCalls(host.request, "chat.send")).toEqual([]);
    expect(removeQueuedMessage(host, stored[0]!.id, { discard: true })).toBe("removed");
    release.resolve();
    await Promise.all([first, second]);
    expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    expect(requestCalls(host.request, "chat.send")[0]?.[1]).toMatchObject({
      message: "Second prompt",
    });
    expect(host.chatMessage).toBe("Unsubmitted third prompt");
  } finally {
    release.resolve();
    await Promise.all([first, second]);
    host.sessions.dispose();
  }
});

it.each(["row", "connection"] as const)(
  "does not dispatch after the admitted %s changes during code loading",
  async (changed) => {
    const started = createDeferred();
    const release = createDeferred();
    // mock-isolation: Preserve the real engine while delaying its first available implementation.
    vi.doMock(import("./chat-send-delivery.runtime.ts"), async (importOriginal) => {
      started.resolve();
      await release.promise;
      return importOriginal();
    });
    const host = makeChatHost({ chatMessage: "Original prompt", requestHandlers: {} });
    const sending = handleSendChat(host);
    const stored = listStoredChatOutboxes(host)[0]?.queue[0];
    try {
      await awaitGateBeforeSettlement(started.promise, sending, "Delivery import was bypassed");
      if (changed === "row") {
        updateQueuedMessage(host, stored!.id, (row) => ({ ...row, text: "Replacement prompt" }));
      } else {
        host.connectionEpoch += 1;
      }
      release.resolve();
      await sending;
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
      expect(readQueuedMessageById(host, stored!.id)).toMatchObject({
        text: changed === "row" ? "Replacement prompt" : "Original prompt",
        sendAttempts: 0,
        sendState: "waiting-idle",
      });
    } finally {
      release.resolve();
      await sending;
      host.sessions.dispose();
    }
  },
);
