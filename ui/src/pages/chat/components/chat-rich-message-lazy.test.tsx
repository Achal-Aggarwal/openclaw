/* @vitest-environment jsdom */

import { createSignal, For } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { MessageGroupContent } from "./chat-message-group-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { createMessageGroup, createToolResultMessage } from "./chat-message.test-support.ts";

it("keeps ordinary transcript text synchronous", () => {
  const view = mountSolid(() => (
    <GroupedMessage
      preparation={prepareChatMessageRender({ role: "assistant", content: "Ready immediately" })}
      messageKey="plain"
      options={{ isStreaming: false, showReasoning: false }}
    />
  ));
  onTestFinished(view.unmount);
  expect(view.container.querySelector(".chat-text")?.textContent?.trim()).toBe("Ready immediately");
});

it("keeps ordinary message-group text synchronous", () => {
  const group = createMessageGroup(
    { role: "assistant", content: "Ready inside the run." },
    "assistant",
  );
  const view = mountSolid(() => (
    <MessageGroupContent group={group} options={{ showReasoning: false }} />
  ));
  onTestFinished(view.unmount);
  expect(view.container.querySelector(".chat-text")?.textContent?.trim()).toBe(
    "Ready inside the run.",
  );
});

it("keeps transcript frame text synchronous and current", async () => {
  const { nativeRows } = await import("./chat-transcript-rows.ts");
  const Frame = nativeRows.frame;
  const frameFor = (text: string) => ({
    kind: "agent-run-frame" as const,
    key: "retained-frame",
    runId: "retained-run",
    boundaryId: "retained-boundary",
    outcome: { kind: "completed" as const, actionOwner: null },
    parts: [createMessageGroup({ role: "assistant", content: text, timestamp: 1 }, "assistant")],
  });
  const [frame, setFrame] = createSignal(frameFor("Earlier text"));
  const view = mountSolid(() => (
    <Frame
      frame={frame()}
      options={{
        streamOptions: {},
        renderGroupOptions: () => ({ isStreaming: false, showReasoning: false }),
        isWorkExpanded: () => false,
        onToggleWork: () => {},
      }}
    />
  ));
  onTestFinished(view.unmount);
  flush();
  expect(view.container.querySelector(".chat-text")?.textContent?.trim()).toBe("Earlier text");
  setFrame(frameFor("Current text"));
  flush();
  expect(view.container.querySelector(".chat-text")?.textContent?.trim()).toBe("Current text");
  expect(view.container.textContent).not.toContain("Earlier text");
});

it("retains Markdown through rich-content and image import retries and uses current callbacks", async () => {
  const richFirst = createDeferred();
  const richRetry = createDeferred();
  const imageFirst = createDeferred();
  const imageRetry = createDeferred();
  const loadRich = vi.fn(() => richFirst.promise);
  const loadImages = vi.fn(() => imageFirst.promise);
  const holdRichImport = () => {
    // Control chunk delivery without replacing the production component or its exports.
    vi.doMock(import("./chat-message-bubble-rich.tsx"), async (original) => {
      await loadRich();
      return original();
    });
  };
  const holdImageImport = () => {
    vi.doMock(import("./chat-message-images-solid.tsx"), async (original) => {
      await loadImages();
      return original();
    });
  };
  holdRichImport();
  holdImageImport();
  onTestFinished(() => {
    richFirst.resolve();
    richRetry.resolve();
    imageFirst.resolve();
    imageRetry.resolve();
    vi.doUnmock("./chat-message-bubble-rich.tsx");
    vi.doUnmock("./chat-message-images-solid.tsx");
  });

  const previousOpen = vi.fn();
  const currentOpen = vi.fn();
  const [messages, setMessages] = createSignal([
    { key: "growing-answer", message: { role: "assistant", content: "A retained paragraph." } },
  ]);
  const [openImage, setOpenImage] = createSignal(() => previousOpen);
  const view = mountSolid(() => (
    <For each={messages()} keyed={(entry) => entry.key}>
      {(entry) => (
        <GroupedMessage
          preparation={prepareChatMessageRender(entry().message)}
          messageKey={entry().key}
          options={{ isStreaming: false, showReasoning: false, onOpenImage: openImage() }}
        />
      )}
    </For>
  ));
  onTestFinished(view.unmount);
  const text = view.container.querySelector(".chat-text");
  const paragraph = text?.querySelector("p");
  expect(paragraph?.textContent).toBe("A retained paragraph.");
  expect(loadRich).not.toHaveBeenCalled();
  expect(loadImages).not.toHaveBeenCalled();

  setMessages([
    {
      key: "growing-answer",
      message: {
        role: "assistant",
        content: "A retained paragraph.\n\nMEDIA:https://example.com/first-image.png",
      },
    },
  ]);
  await waitForSolid(() => expect(loadRich).toHaveBeenCalledOnce());
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  expect(view.container.querySelector(".chat-message-image")).toBeNull();
  expect(loadImages).not.toHaveBeenCalled();
  richFirst.reject(new Error("Rich message chunk could not load"));
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.querySelector(".chat-text")).toBe(text);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);

  loadRich.mockReturnValue(richRetry.promise);
  holdRichImport();
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => {
    expect(loadRich).toHaveBeenCalledTimes(2);
    // Errored retains the failure until the held replacement lands.
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  richRetry.resolve();
  await waitForSolid(() => {
    expect(loadImages).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  imageFirst.reject(new Error("Image renderer chunk could not load"));
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.querySelector(".chat-text")).toBe(text);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);

  loadImages.mockReturnValue(imageRetry.promise);
  holdImageImport();
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => {
    expect(loadImages).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  });
  setOpenImage(() => currentOpen);
  setMessages([
    {
      key: "growing-answer",
      message: {
        role: "assistant",
        content: "A retained paragraph.\n\nMEDIA:https://example.com/current-image.png",
      },
    },
  ]);
  flush();
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  imageRetry.resolve();
  await waitForSolid(() =>
    expect(view.container.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(
      "https://example.com/current-image.png",
    ),
  );
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector(".chat-text")).toBe(text);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  view.container
    .querySelector<HTMLImageElement>(".chat-message-image")!
    .dispatchEvent(new Event("load"));
  view.container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
  expect(previousOpen).not.toHaveBeenCalled();
  expect(currentOpen).toHaveBeenCalledOnce();
});

it("loads rich history beside immediate plain text and retires a superseded message", async () => {
  const question = {
    role: "assistant",
    content: "Choose an audience.",
    openclawAsyncDelivery: {
      itemId: "initial-question",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    },
  };
  const submit = vi.fn(async () => true);
  const questions = createAsyncQuestionPresentation(
    {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: submit },
    },
    { sessionKey: "agent:main:main", messages: [question], onAsyncQuestionSubmit: submit },
  );
  const initialTool = createToolResultMessage("old-call", "exec", "Old tool result");
  const [messages, setMessages] = createSignal([
    { key: "plain", message: { role: "assistant", content: "Visible immediately" } },
    { key: "question", message: question },
    { key: "old", message: initialTool },
  ]);
  const view = mountSolid(() => (
    <For each={messages()} keyed={(entry) => entry.key}>
      {(entry) => (
        <GroupedMessage
          preparation={prepareChatMessageRender(entry().message)}
          messageKey={entry().key}
          options={{ isStreaming: false, showReasoning: false, asyncQuestions: questions }}
        />
      )}
    </For>
  ));
  onTestFinished(view.unmount);
  expect(view.container.textContent).toContain("Visible immediately");
  await waitForSolid(() => {
    expect(view.container.querySelector(".chat-tool-msg-collapse")).not.toBeNull();
    expect(view.container.querySelector(".chat-question-summary")?.textContent).toContain(
      "Which audience?",
    );
  });

  const currentTool = createToolResultMessage("current-call", "exec", "Permission required", {
    details: {
      permissionMissing: {
        nodeId: "example-mac",
        nodeName: "Example Mac",
        command: "screen.capture",
        capabilities: ["screenRecording"],
        state: "denied",
      },
    },
  });
  setMessages((entries) => [...entries.slice(0, 2), { key: "current", message: currentTool }]);
  flush();
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-permission-card")).not.toBeNull(),
  );
  expect(view.container.querySelector(".chat-question-summary")?.textContent).toContain(
    "Which audience?",
  );
  expect(view.container.textContent).toContain("Visible immediately");
  expect(view.container.querySelector('[data-message-id="old"]')).toBeNull();
  expect(view.container.textContent).not.toContain("Old tool result");
});
