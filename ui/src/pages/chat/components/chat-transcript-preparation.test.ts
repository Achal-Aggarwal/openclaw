// @vitest-environment jsdom
import { expect, it } from "vitest";
import { makeUiSettings } from "../../../test-helpers/settings-node.ts";
import { prepareCachedTranscript } from "../chat-transcript-prewarm.ts";
import type { ChatSessionSnapshot } from "../session-message-cache.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { prepareTranscriptRows } from "./chat-transcript-preparation.ts";
import { TranscriptSpecialization as Kind } from "./chat-transcript-specialized.ts";

it("keeps empty and ordinary text snapshots synchronous without a renderer request", () => {
  expect(prepareTranscriptRows([])).toBeUndefined();
  expect(
    prepareCachedTranscript(
      {
        messages: [{ role: "assistant", content: "Cached answer", timestamp: 1 }],
        pagination: { hasMore: false },
        sessionId: "cached",
      },
      "agent:main:cached",
      makeUiSettings("ws://example.test"),
      false,
      "main",
    ),
  ).toBeUndefined();
});

it("includes a resident recovery candidate for the current source id", () => {
  const message = { role: "assistant", messageId: "recovered", timestamp: 1, content: "Preview" };
  const recovered = {
    ...message,
    openclawAsyncDelivery: { itemId: "question-2", questions: [{ title: "Continue?" }] },
  };
  const request = prepareTranscriptRows(
    [{ kind: "item", key: "recovered", item: createMessageGroup(message, "assistant") }],
    {
      asyncQuestions: true,
      getAssistantMessageExpansion: (id) =>
        id === "recovered"
          ? { status: "loaded", revision: 2, markdown: "Full message", message: recovered }
          : undefined,
    },
  );
  expect(request?.key).toBe(Kind.asyncQuestions);
});

it("prepares thinking-only cached questions when reasoning is visible", async () => {
  const settings = makeUiSettings("ws://example.test");
  settings.chatShowThinking = true;
  const snapshot: ChatSessionSnapshot = {
    messages: [
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "thinking", thinking: "Choose the next step" }],
        openclawAsyncDelivery: { itemId: "thinking-question", questions: [{ title: "Continue?" }] },
      },
    ],
    pagination: { hasMore: false },
    sessionId: "cached-thinking",
    historyState: {
      stateRevision: {},
      sessionInfo: { key: "agent:main:cached", kind: "direct", updatedAt: 1, reasoningLevel: "on" },
    },
  };
  const preparation = prepareCachedTranscript(
    snapshot,
    "agent:main:cached",
    settings,
    false,
    "main",
  );
  expect(preparation).toBeInstanceOf(Promise);
  await preparation;
});
