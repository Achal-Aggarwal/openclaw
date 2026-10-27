/* @vitest-environment jsdom */

import { createSignal, For } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import { createHeldImport } from "./chat-lazy-import.test-support.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { createToolResultMessage } from "./chat-message.test-support.ts";

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

it("retains Markdown through rich-content and image import retries and uses current callbacks", async () => {
  const richFirst = createHeldImport<typeof import("./chat-message-bubble-rich.tsx")>();
  const richRetry = createHeldImport<typeof import("./chat-message-bubble-rich.tsx")>();
  const imageFirst = createHeldImport<typeof import("./chat-message-images-solid.tsx")>();
  const imageRetry = createHeldImport<typeof import("./chat-message-images-solid.tsx")>();
  const loadRich = vi.fn(richFirst.load);
  const loadImages = vi.fn(imageFirst.load);
  const holdRichImport = () => {
    vi.doMock(import("./chat-message-bubble-rich.tsx"), loadRich);
  };
  const holdImageImport = () => {
    vi.doMock(import("./chat-message-images-solid.tsx"), loadImages);
  };
  holdRichImport();
  holdImageImport();
  onTestFinished(() => {
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
  richFirst.ready.reject(new Error("Rich message chunk could not load"));
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.querySelector(".chat-text")).toBe(text);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);

  loadRich.mockImplementation(richRetry.load);
  holdRichImport();
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await waitForSolid(() => {
    expect(loadRich).toHaveBeenCalledTimes(2);
    // Errored retains the failure until the held replacement lands.
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  richRetry.ready.resolve();
  await waitForSolid(() => {
    expect(loadImages).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  imageFirst.ready.reject(new Error("Image renderer chunk could not load"));
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.querySelector(".chat-text")).toBe(text);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);

  loadImages.mockImplementation(imageRetry.load);
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
  imageRetry.ready.resolve();
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
