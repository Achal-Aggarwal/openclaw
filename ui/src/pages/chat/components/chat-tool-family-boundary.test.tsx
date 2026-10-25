/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "../chat-view-state.test-support.ts";
import {
  createReactiveDraftHarness,
  getComposerTextarea,
  inputDraft,
} from "../chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  vi.doUnmock("../chat-tool-family-runtime.ts");
});

function richMessage(id: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: { command: `echo ${id}` } }],
  };
}

it("keeps the real composer editable while the transcript waits for and retries tool code", async () => {
  const load = vi.fn();
  const releaseImports: (() => void)[] = [];
  const holdImport = () => {
    const ready = createDeferred();
    const entered = createDeferred();
    const settled = createDeferred();
    const requests = vi.fn();
    releaseImports.push(() => ready.resolve());
    // Only chunk delivery is controlled; the loader, demand check, and card parser stay real.
    vi.doMock(import("../chat-tool-family-runtime.ts"), async (original) => {
      load();
      requests();
      entered.resolve();
      try {
        await ready.promise;
        return await original();
      } finally {
        settled.resolve();
      }
    });
    return { ready, entered, settled, requests };
  };
  onTestFinished(() => {
    for (const release of releaseImports) {
      release();
    }
    vi.doUnmock("../chat-tool-family-runtime.ts");
  });

  const first = holdImport();
  const onDraftChange = vi.fn();
  const view = createReactiveDraftHarness({
    paneId: "tool-family-boundary",
    sessionKey: "agent:main:tool-family-boundary",
    messages: [{ role: "assistant", content: "First plain answer" }],
    onDraftChange,
  });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-thread")?.textContent).toContain(
      "First plain answer",
    ),
  );
  expect(load).not.toHaveBeenCalled();
  const composer = getComposerTextarea(view.container);
  inputDraft(view.container, "Keep this draft");

  view.renderCurrent({ messages: [richMessage("stale-tool")] });
  await first.entered.promise;
  flush();
  expect(load).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain("echo stale-tool");
  expect(getComposerTextarea(view.container)).toBe(composer);
  expect(composer.value).toBe("Keep this draft");

  view.renderCurrent({ messages: [{ role: "assistant", content: "Replacement plain answer" }] });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-thread")?.textContent).toContain(
      "Replacement plain answer",
    ),
  );
  first.ready.reject(new Error("Retired tool import failed"));
  await first.settled.promise;
  await vi.dynamicImportSettled();
  flush();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(load).toHaveBeenCalledOnce();
  expect(view.container.querySelector(".chat-thread")?.textContent).toContain(
    "Replacement plain answer",
  );

  const failed = holdImport();
  view.renderCurrent({ messages: [richMessage("failed-tool")] });
  await failed.entered.promise;
  failed.ready.reject(new Error("Tool details could not load"));
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Tool details could not load",
    ),
  );
  expect(view.container.textContent).not.toContain("echo failed-tool");
  expect(getComposerTextarea(view.container)).toBe(composer);
  expect(composer.disabled).toBe(false);
  inputDraft(view.container, "Still editable after tool failure");
  expect(onDraftChange).toHaveBeenLastCalledWith("Still editable after tool failure");

  const retry = holdImport();
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await retry.entered.promise;
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  view.renderCurrent({ messages: [richMessage("current-tool")] });
  flush();
  expect(view.container.textContent).not.toContain("echo current-tool");
  expect(getComposerTextarea(view.container)).toBe(composer);
  inputDraft(view.container, "Still editable during retry");
  retry.ready.resolve();
  await retry.settled.promise;
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-thread")?.textContent).toContain(
      "echo current-tool",
    ),
  );
  expect(retry.requests).toHaveBeenCalledOnce();
  expect(view.container.textContent).not.toContain("echo stale-tool");
  expect(view.container.textContent).not.toContain("echo failed-tool");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(getComposerTextarea(view.container)).toBe(composer);
  expect(composer.value).toBe("Still editable during retry");
  expect(onDraftChange).toHaveBeenLastCalledWith("Still editable during retry");
});
