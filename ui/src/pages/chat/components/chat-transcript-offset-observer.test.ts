/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  canAutoFollowChat,
  type ChatScrollHost,
  handleChatScroll,
  handleChatScrollTakeover,
} from "../scroll.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  isTranscriptProgrammaticScroll,
  observeTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";

it.each([false, true])(
  "classifies an idle or pending offset without layout (pending: %s)",
  (pending) => {
    const state = new TranscriptOffsetState();
    if (pending) {
      state.pendingScrollOffset = { offset: 200, stableFrames: 0, zeroMaxFrames: 0 };
      state.maintenanceScrollOffset = 100;
    }
    const element = document.createElement("div");
    const readGeometry = vi.fn(() => 100);
    for (const key of ["scrollTop", "scrollHeight", "clientHeight"]) {
      Object.defineProperty(element, key, { get: readGeometry });
    }
    expect(isTranscriptProgrammaticScroll(state, element)).toBe(pending);
    expect(readGeometry).not.toHaveBeenCalled();
  },
);

it("keeps maintenance and active commands owned until the committed viewport settles", () => {
  const state = new TranscriptOffsetState();
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
  });
  state.maintenanceScrollOffset = 900;
  element.scrollTop = 800;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(true);
  element.scrollTop = 400;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
  state.maintenanceScrollOffset = null;
  state.scrollCommand = { behavior: "smooth", target: "end" };
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(true);
  element.scrollTop = 800;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
});

it("delivers native offsets without checking end geometry when no end command is active", () => {
  const element = document.createElement("div");
  const readGeometry = vi.fn(() => 100);
  for (const key of ["scrollHeight", "clientHeight"]) {
    Object.defineProperty(element, key, { get: readGeometry });
  }
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 40,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = element;
  virtualizer.targetWindow = window;
  const onOffset = vi.fn();
  const deliver = vi.fn();
  onTestFinished(
    observeTranscriptOffset(
      {
        state: new TranscriptOffsetState(),
        getScrollElement: () => element,
        endAnchor: new TranscriptEndAnchor(() => {}),
        prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
        canFollowEnd: () => false,
        isProgrammaticScroll: () => false,
        cancelScroll: vi.fn(),
        onLayoutCorrection: vi.fn(),
        invalidate: vi.fn(),
        onOffset,
        onReaderScroll: vi.fn(),
        onComposerLayout: vi.fn(),
      },
      virtualizer,
      deliver,
    ),
  );
  element.scrollTop = 20;
  element.dispatchEvent(new Event("scroll"));
  expect(deliver).toHaveBeenCalledWith(20, true);
  expect(onOffset).toHaveBeenCalledOnce();
  expect(readGeometry).not.toHaveBeenCalled();
});

it.each([
  { position: "end", offset: 800, expected: 870, following: true },
  { position: "history", offset: 600, expected: 600, following: false },
])("preserves $position after synchronizing a reader before its scroll event", (testCase) => {
  const element = document.createElement("div");
  let scrollHeight = 1000;
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => scrollHeight },
  });
  element.scrollTop = 400;
  const state = new TranscriptOffsetState();
  const endAnchor = new TranscriptEndAnchor(() => {});
  const policy: ChatScrollHost = {
    renderLifecycle: { afterCommit: () => () => {} },
    chatScrollElement: () => element,
    chatLastScrollTop: 400,
    chatHasAutoScrolled: true,
    chatUserNearBottom: false,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
  };
  handleChatScrollTakeover(policy);
  expect(canAutoFollowChat(policy)).toBe(false);

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    initialOffset: 400,
    getScrollElement: () => element,
    estimateSize: () => 40,
    scrollToFn: (offset) => {
      element.scrollTop = offset;
    },
    observeElementRect: (_, callback) => callback({ width: 800, height: 200 }),
    observeElementOffset: (instance, callback) =>
      observeTranscriptOffset(
        {
          state,
          getScrollElement: () => element,
          endAnchor,
          prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
          canFollowEnd: () => canAutoFollowChat(policy),
          isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
          cancelScroll: vi.fn(),
          onLayoutCorrection: (before, after) => endAnchor.recordLayoutCorrection(before, after),
          invalidate: vi.fn(),
          onOffset: () => endAnchor.recordViewport(element),
          onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
          onComposerLayout: vi.fn(),
        },
        instance,
        callback,
      ),
  });
  const { _didMount: mount, _willUpdate: update } = virtualizer;
  onTestFinished(mount());
  update();
  const onScroll = (event: Event) => handleChatScroll(policy, event);
  element.addEventListener("scroll", onScroll);
  onTestFinished(() => element.removeEventListener("scroll", onScroll));
  element.dispatchEvent(new Event("scroll"));

  // ResizeObserver can synchronize physical movement before the native scroll event.
  element.scrollTop = testCase.offset;
  state.syncNativeOffset?.();
  expect(virtualizer.scrollOffset).toBe(testCase.offset);
  element.dispatchEvent(new Event("scroll"));
  expect(canAutoFollowChat(policy)).toBe(testCase.following);

  scrollHeight += 70;
  endAnchor.reconcile(element, canAutoFollowChat(policy), false, () => {
    element.scrollTop = scrollHeight - element.clientHeight;
  });
  expect(element.scrollTop).toBe(testCase.expected);
});
