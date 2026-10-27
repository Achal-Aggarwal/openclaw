/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { getTranscriptState, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

const streamImport = vi.hoisted(() => {
  const first = Promise.withResolvers<void>();
  const retry = Promise.withResolvers<void>();
  let pending = first.promise;
  return {
    first,
    retry,
    holding: false,
    evaluations: 0,
    load: vi.fn(() => pending),
    retryNext: () => {
      pending = retry.promise;
    },
  };
});

// mock-isolation: Observe collection-time imports without holding module collection open.
vi.mock(import("./chat-message-stream-view.tsx"), async (importOriginal) => {
  streamImport.evaluations += 1;
  if (streamImport.holding) {
    await streamImport.load();
  }
  return importOriginal();
});

it("retains committed rows while a first stream loads, retries failure, and accepts later deltas", async () => {
  expect(streamImport.evaluations).toBe(0);
  streamImport.holding = true;
  installTranscriptDomMocks();
  const frame = stubAnimationFrames();
  const transcript = createTestTranscript("lazy-native-rows");
  const firstReply = vi.fn();
  const nextReply = vi.fn();
  const initial = threadProps("lazy-native-rows", "agent:main:lazy-native-rows", undefined, {
    onSetReply: firstReply,
  });
  let update!: (props: ChatThreadProps) => void;
  const view = mountSolid(() => {
    const [props, setProps] = createSignal(initial);
    update = setProps;
    return (
      <>
        <input aria-label="Message" defaultValue="Keep this draft" />
        <ChatThread props={props()} transcript={transcript} />
      </>
    );
  });
  onTestFinished(() => {
    streamImport.first.resolve();
    streamImport.retry.resolve();
    streamImport.holding = false;
    view.unmount();
    transcript.dispose();
    resetTranscriptTestDom();
  });
  transcript.start();
  transcript.update();
  const settle = () =>
    waitForSolid(() => {
      frame();
      flush();
      expect(transcript.isPositionSettled).toBe(true);
    });
  await settle();
  expect(streamImport.load).not.toHaveBeenCalled();
  const row = view.container.querySelector(".chat-virtual-row");
  expect(row).not.toBeNull();
  const composer = view.container.querySelector("input")!;
  const context = getTranscriptState(initial.paneId).transcriptRenderContext;
  expect(context.onSetReply).toBe(firstReply);
  const next = {
    ...initial,
    onSetReply: nextReply,
    runActive: true,
    stream: "First streamed answer",
    streamStartedAt: 5_000,
  };
  update(next);
  flush();
  await vi.waitFor(() => expect(streamImport.load).toHaveBeenCalled());
  frame();
  flush();
  expect(transcript.isPositionSettled).toBe(false);
  expect(view.container.querySelector(".chat-virtual-row")).toBe(row);
  expect(context.onSetReply).toBe(firstReply);
  expect(view.container.textContent).not.toContain(next.stream);
  composer.value = "Still editable";
  streamImport.first.reject(new Error("Synthetic stream import failure"));
  await waitForSolid(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
  expect(view.container.querySelector("input")).toBe(composer);
  expect(composer.value).toBe("Still editable");
  expect(transcript.isPositionSettled).toBe(false);
  streamImport.retryNext();
  const previousLoads = streamImport.load.mock.calls.length;
  view.container.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  await vi.waitFor(() =>
    expect(streamImport.load.mock.calls.length).toBeGreaterThan(previousLoads),
  );
  streamImport.retry.resolve();
  await waitForSolid(() => expect(view.container.textContent).toContain(next.stream));
  await settle();
  expect(context.onSetReply).toBe(nextReply);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  const committedRow = view.container.querySelector(".chat-virtual-row");
  const settledLoads = streamImport.load.mock.calls.length;
  const settledEvaluations = streamImport.evaluations;
  update({ ...next, stream: "First streamed answer continues" });
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("First streamed answer continues"),
  );
  expect(view.container.querySelector(".chat-virtual-row")).toBe(committedRow);
  expect(streamImport.load).toHaveBeenCalledTimes(settledLoads);
  expect(streamImport.evaluations).toBe(settledEvaluations);
  expect(view.container.querySelector("input")).toBe(composer);
  expect(composer.value).toBe("Still editable");
});
