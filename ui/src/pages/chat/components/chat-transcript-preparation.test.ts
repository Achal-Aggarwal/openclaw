// @vitest-environment jsdom
import { expect, it } from "vitest";
import { makeUiSettings } from "../../../test-helpers/settings-node.ts";
import { prepareCachedTranscript } from "../chat-transcript-prewarm.ts";
import type { ChatSessionSnapshot } from "../session-message-cache.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { prepareTranscriptRows } from "./chat-transcript-preparation.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
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

it("prepares only the requested work factory and treats a resolved factory as resident", async () => {
  const group = createMessageGroup(
    { role: "assistant", content: "Work", timestamp: 1 },
    "assistant",
  );
  const native = {
    kind: "work" as const,
    item: { key: "work", durationMs: 12, groups: [group] },
    options: { expanded: false, onToggle() {} },
  };
  const rows = [
    { kind: "content" as const, key: "work", content: new GuardedTranscriptItem([native], native) },
  ];
  const request = prepareTranscriptRows(rows)!;
  expect(request.key).toBe(Kind.work);
  await request.load();
  expect(prepareTranscriptRows(rows)!.ready()).toBe(true);
});

it("collects nested work and forwarded facts without rendering their message bodies", () => {
  const group = createMessageGroup(
    { role: "assistant", content: "Forwarded", timestamp: 1 },
    "assistant",
    { senderSession: { sessionKey: "agent:other:main" } },
  );
  const request = prepareTranscriptRows([
    { kind: "item", key: "group", item: group },
    {
      kind: "item",
      key: "work",
      item: { kind: "work-group", key: "work", groups: [group], durationMs: 5 },
    },
  ]);
  expect(request?.key).toBe(Kind.work | Kind.forwarded);
});

it("prepares recorded async questions only when their presentation is enabled", () => {
  const message = {
    role: "assistant",
    messageId: "question-message",
    timestamp: 1,
    content: "Choose a destination",
    openclawAsyncDelivery: {
      itemId: "question-1",
      questions: [{ title: "Where?", options: ["Here", "There"] }],
    },
  };
  const row = {
    kind: "item" as const,
    key: "question",
    item: createMessageGroup(message, "assistant"),
  };
  expect(prepareTranscriptRows([row], { asyncQuestions: true })?.key).toBe(Kind.asyncQuestions);
  expect(prepareTranscriptRows([row], { asyncQuestions: false })).toBeUndefined();
  expect(
    prepareTranscriptRows([
      {
        ...row,
        item: createMessageGroup(
          { ...message, openclawAsyncDelivery: { itemId: "question-1", questions: [] } },
          "assistant",
        ),
      },
    ]),
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

it("requires the conflict renderer only for a valid transcript conflict", () => {
  const message = {
    role: "custom",
    customType: "cloud-workspace-conflict",
    timestamp: 1,
    content: "Workspace needs review",
    details: {
      paths: ["src/main.ts"],
      stagedResultRef: "refs/openclaw/worker-results/example",
    },
  };
  expect(
    prepareTranscriptRows([
      { kind: "item", key: "conflict", item: createMessageGroup(message, "custom") },
    ])?.key,
  ).toBe(Kind.workspaceConflict);
  expect(
    prepareTranscriptRows([
      {
        kind: "item",
        key: "invalid-conflict",
        item: createMessageGroup(
          { ...message, details: { ...message.details, paths: ["../outside"] } },
          "custom",
        ),
      },
    ]),
  ).toBeUndefined();
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
