import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Warm history subscription" });
const sessionKey = "agent:main:thread:warm-history-subscription";
const cursor = "cached-history-cursor";
const session = createControlUiSessionRow(sessionKey, "Warm history", 1, {
  activeLeafEntryId: "cached-leaf",
});
const message = (seq: number, text: string, id = `entry-${seq}`) => ({
  role: seq % 2 ? "user" : "assistant",
  content: text,
  __openclaw: { id, seq },
});
const cached = [message(1, "Saved question"), message(2, "Saved answer")];
const added = [message(3, "Next question"), message(4, "Next answer")];

async function expectTranscript(page: Page, texts: string[]): Promise<void> {
  await expect
    .poll(async () =>
      (
        await page
          .locator(".chat-pane-cache__pane--active .chat-thread .chat-text")
          .allTextContents()
      ).map((text) => text.trim()),
    )
    .toEqual(texts);
}

async function persistTranscript(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
  );
  await page.locator(".chat-pane-cache__pane--active").evaluate(async (element) => {
    const pane = element as HTMLElement & { sessionSnapshotStore?: SessionSnapshotStore };
    if (!pane.sessionSnapshotStore) {
      throw new Error("Missing transcript snapshot owner");
    }
    await pane.sessionSnapshotStore.flush();
  });
}

suite.define(() => {
  it.each(["current", "new messages", "stale", "compaction", "branch change"] as const)(
    "revalidates a persisted transcript after %s on warm reload",
    async (change) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          sessionKey,
          sessions: [session],
          heldMethods: ["sessions.messages.subscribe", "chat.startup"],
          methodResponses: {
            "chat.startup": {
              sessionId: session.sessionId,
              sessionInfo: session,
              messages: cached,
              deltaCursor: cursor,
              hasMore: false,
              totalMessages: cached.length,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const cold = await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: sessionKey },
        });
        expect(cold.params).toHaveProperty("initialHistory");
        expect(cold.params).not.toHaveProperty("initialHistory.cursor");
        await gateway.resolveDeferred("sessions.messages.subscribe");
        await expectTranscript(page, ["Saved question", "Saved answer"]);
        expect(await gateway.getRequests("chat.startup")).toEqual([]);
        await persistTranscript(page);

        const reset = change === "stale" || change === "compaction" || change === "branch change";
        const replacement = change === "compaction" || change === "branch change";
        const finalMessages = replacement
          ? [
              message(1, "Replacement question", "replacement-1"),
              message(2, "Replacement answer", "replacement-2"),
            ]
          : change === "current"
            ? cached
            : [...cached, ...added];
        const finalSession = {
          ...session,
          ...(change === "compaction" ? { sessionId: "compacted-session" } : {}),
          activeLeafEntryId:
            change === "branch change"
              ? "replacement-leaf"
              : change === "new messages" || change === "stale"
                ? "entry-4"
                : session.activeLeafEntryId,
        };
        const full = {
          sessionId: finalSession.sessionId,
          sessionInfo: finalSession,
          messages: finalMessages,
          deltaCursor: "current-history-cursor",
          hasMore: false,
          totalMessages: finalMessages.length,
        };
        await gateway.setMethodResponse(
          "chat.startup",
          reset
            ? { cases: [{ match: { cursor }, response: { kind: "reset" } }, { response: full }] }
            : {
                kind: "delta",
                sessionInfo: finalSession,
                deltaCursor: "current-history-cursor",
                messages:
                  change === "current"
                    ? []
                    : added.map((entry) => ({
                        message: entry,
                        messageId: entry.__openclaw.id,
                        messageSeq: entry.__openclaw.seq,
                      })),
              },
        );
        await page.reload();
        const warm = await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: sessionKey },
        });
        expect(warm.params).toMatchObject({ initialHistory: { cursor } });
        await expectTranscript(page, ["Saved question", "Saved answer"]);
        await gateway.setSessionsListResponse({ sessions: [finalSession] });
        await gateway.resolveDeferred("sessions.messages.subscribe");
        if (reset) {
          const refill = await gateway.waitForRequest("chat.startup");
          expect(refill.params).not.toHaveProperty("cursor");
          await expectTranscript(page, ["Saved question", "Saved answer"]);
          await gateway.resolveDeferred("chat.startup");
        }
        const pane = page.locator(".chat-pane-cache__pane--active");
        await expect
          .poll(() =>
            pane.evaluate((element: ChatPaneElement) => ({
              ready: element.transcriptReady,
              loading: element.transcriptLoading,
            })),
          )
          .toEqual({ ready: true, loading: false });
        expect(await pane.locator(".chat-history-error").count()).toBe(0);
        await expectTranscript(
          page,
          finalMessages.map((entry) => entry.content),
        );
        expect(await gateway.getRequests("chat.startup")).toHaveLength(reset ? 1 : 0);
        expect(await gateway.getRequests("chat.history")).toEqual([]);
      });
    },
  );
});
