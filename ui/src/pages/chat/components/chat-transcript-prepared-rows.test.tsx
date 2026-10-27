/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { prewarmGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetTranscriptTestDom();
});

async function settle() {
  // Row refs and the retained root's commit each cross a microtask boundary.
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve();
    flush();
  }
}

async function transcriptFixture(
  initialOffset: number | null = 0,
  idlePreparation = false,
  plainFirstRow = false,
  ordinary: boolean | "retained" = false,
  viewportHeight = 600,
  completedFrame: boolean | "toolCall" = false,
) {
  let now = 1;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let nextIdle = 0;
  const idleCallbacks = new Map<number, IdleRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  if (idlePreparation) {
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.set(++nextIdle, callback);
        return nextIdle;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => idleCallbacks.delete(id)),
    );
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, viewportHeight),
  );
  const container = document.body.appendChild(document.createElement("div"));
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: viewportHeight },
    offsetWidth: { configurable: true, value: 800 },
    offsetHeight: { configurable: true, value: viewportHeight },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(host.contentElement?.style.height ?? "0") || 0,
    },
  });
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      container.scrollTop = Math.max(
        0,
        Math.min(options.top ?? container.scrollTop, container.scrollHeight - viewportHeight),
      );
    }
  };
  const rows: TranscriptRow<number>[] = Array.from({ length: 256 }, (_, index) => ({
    kind: "item",
    key: `fragment:${index}`,
    item: index,
    estimatedSize: index === 0 && plainFirstRow ? undefined : 100,
    retainDom: ordinary !== true && !(index === 0 && plainFirstRow),
  }));
  const groups = ordinary
    ? rows.map((_, index) =>
        createMessageGroup(
          { role: "assistant", content: `Idle ordinary message ${index}`, timestamp: index },
          "assistant",
          completedFrame
            ? {
                messages: ["first", "second"].map((part) => ({
                  key: `idle-frame-${index}-${part}`,
                  message: {
                    role: "assistant",
                    content:
                      completedFrame === "toolCall"
                        ? [
                            { type: "text", text: `**idle-frame-${index}-${part}-toolCall**` },
                            {
                              type: "toolCall",
                              id: `idle-tool-${index}-${part}`,
                              name: "read",
                              arguments: {},
                            },
                          ]
                        : `**idle-frame-${index}-${part}**`,
                    timestamp: index,
                  },
                })),
              }
            : {},
        ),
      )
    : [];
  let presented = true;
  let queued = false;
  let disposed = false;
  const renderRow = vi.fn((row: TranscriptRow<number>) => {
    if (!ordinary) {
      return <span>Message {row.kind === "item" ? row.item : ""}</span>;
    }
    const group = groups[row.kind === "item" ? row.item : 0]!;
    return new GuardedTranscriptItem(
      [group],
      completedFrame
        ? {
            kind: "frame",
            frame: {
              kind: "agent-run-frame",
              key: `frame:${group.key}`,
              runId: group.key,
              boundaryId: group.key,
              outcome: { kind: "completed", actionOwner: group.messages.at(-1)! },
              parts: [group],
            },
            options: {
              streamOptions: {},
              workPreviews: new Map(),
              renderGroupOptions: () => ({ showReasoning: false }),
              isWorkExpanded: () => false,
              onToggleWork: () => {},
            },
          }
        : {
            kind: "group",
            group,
            options: { showReasoning: false },
          },
    );
  });
  let renderer = renderRow;
  const draw = vi.fn(() => {
    const root = host.render(rows, renderer, null, false, null, null, presented);
    if (root.parentElement !== container) {
      container.append(root);
    }
    host.update();
    flush();
  });
  const host = new ChatSessionVirtualizerHost(() => {
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) {
          draw();
        }
      });
    }
  }, initialOffset);
  disposers.push(() => {
    disposed = true;
    host.dispose();
  });
  host.setContentReady(true);
  host.connect();
  draw();
  await settle();
  return {
    container,
    host,
    draw,
    renderRow,
    groups,
    async updateRow(index: number, item: number) {
      rows[index] = {
        kind: "item",
        key: `fragment:${index}`,
        item,
        estimatedSize: 100,
        retainDom: true,
      };
      draw();
      await settle();
    },
    async replaceRenderer() {
      renderer = vi.fn((row: TranscriptRow<number>) => (
        <span>Updated {row.kind === "item" ? row.item : ""}</span>
      ));
      draw();
      await settle();
    },
    async frame(count = 1, measure = true) {
      for (let index = 0; index < count; index++) {
        now += 16;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) {
          callback(now);
        }
        await settle();
        if (measure) {
          for (const row of container.querySelectorAll<HTMLElement>("[data-prepared-row]")) {
            emitTranscriptResize(row, 800, 100);
          }
        }
        await settle();
      }
    },
    async idle(available = 10) {
      const pending = [...idleCallbacks.values()];
      idleCallbacks.clear();
      for (const callback of pending) {
        callback({ didTimeout: false, timeRemaining: () => available });
      }
      await settle();
      for (const row of container.querySelectorAll<HTMLElement>("[data-prepared-row]")) {
        emitTranscriptResize(row, 800, 100);
      }
      await settle();
    },
    async task() {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await settle();
    },
    async scrollTo(index: number) {
      container.scrollTop = index * 100;
      container.dispatchEvent(new Event("scroll"));
      await settle();
    },
    async present(value: boolean) {
      presented = value;
      draw();
      await settle();
    },
  };
}

it.each([600, 1400])(
  "warms ordinary rows only in idle time without mounting their DOM (%i px)",
  async (height) => {
    const view = await transcriptFixture(0, true, false, true, height);
    if (height === 1400) {
      expect(
        view.container.querySelectorAll(".chat-virtual-row:not([data-prepared-row])").length,
      ).toBeGreaterThan(12);
    }
    const rendered = view.renderRow.mock.calls.length;
    const elements = view.container.querySelectorAll(".chat-virtual-row").length;
    await view.idle(0);
    expect(view.renderRow.mock.calls).toHaveLength(rendered);
    await view.idle();
    expect(view.renderRow.mock.calls.length).toBeGreaterThan(rendered);
    const warmed = view.renderRow.mock.calls.slice(rendered).at(-1)![0];
    const index = warmed.kind === "item" ? warmed.item : -1;
    expect(index).toBeGreaterThan(0);
    expect(view.container.querySelector(`[data-virtual-row-key="${warmed.key}"]`)).toBeNull();
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(elements);
    expect(prewarmGroupedMessage(view.groups[index]!.messages[0]!.message, {})).toBe(false);
    for (let turn = 0; turn < 80; turn++) {
      await view.idle();
    }
    const last = view.renderRow.mock.calls.at(-1)![0];
    expect(last.kind === "item" ? last.item : -1).toBeGreaterThan(index);
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(elements);
    // A fast first movement can cross several viewports before scroll warming runs.
    expect(prewarmGroupedMessage(view.groups[48]!.messages[0]!.message, {})).toBe(false);
    const completed = view.renderRow.mock.calls.length;
    await view.idle();
    expect(view.renderRow.mock.calls).toHaveLength(completed);
  },
);

it.each([true, "toolCall"] as const)(
  "warms completed frame messages with %s one per idle callback before their first mount",
  async (content) => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const view = await transcriptFixture(0, true, false, true, 600, content);
    const rendered = view.renderRow.mock.calls.length;
    const elements = view.container.querySelectorAll(".chat-virtual-row").length;
    await view.idle(0);
    expect(view.renderRow.mock.calls).toHaveLength(rendered);

    await view.idle();
    const warmed = view.renderRow.mock.calls.slice(rendered).at(-1)![0];
    const index = warmed.kind === "item" ? warmed.item : -1;
    expect(index).toBeGreaterThan(0);
    const first = `idle-frame-${index}-first`;
    const second = `idle-frame-${index}-second`;
    const parsesFor = (text: string) =>
      parse.mock.calls.filter(([input]) => input.includes(text)).length;
    expect(parsesFor(first)).toBeGreaterThan(0);
    expect(parsesFor(second)).toBe(0);
    expect(view.container.querySelector(`[data-virtual-row-key="${warmed.key}"]`)).toBeNull();
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(elements);

    await view.idle();
    expect(parsesFor(second)).toBeGreaterThan(0);
    expect(view.container.querySelector(`[data-virtual-row-key="${warmed.key}"]`)).toBeNull();
    const beforeMount = [parsesFor(first), parsesFor(second)];
    await view.scrollTo(index);
    const row = view.container.querySelector(`[data-virtual-row-key="${warmed.key}"]`);
    expect(row?.textContent).toContain(first);
    expect(row?.textContent).toContain(second);
    expect([parsesFor(first), parsesFor(second)]).toEqual(beforeMount);
  },
);

it.each([1, -1])(
  "warms the next ordinary viewport before its frame in direction %s without idle delivery",
  async (direction) => {
    const view = await transcriptFixture(direction > 0 ? 0 : 24_000, true, false, true, 1_000);
    await view.scrollTo(direction > 0 ? 60 : 180);
    const rendered = view.renderRow.mock.calls.length;
    const elements = view.container.querySelectorAll(".chat-virtual-row").length;
    expect(view.renderRow.mock.calls).toHaveLength(rendered);
    await view.frame(1, false);
    await view.task();
    const prepared = view.renderRow.mock.calls.slice(rendered);
    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.length).toBeGreaterThan(8);
    const last = prepared.at(-1)![0];
    const index = last.kind === "item" ? last.item : -1;
    expect(prewarmGroupedMessage(view.groups[index]!.messages[0]!.message, {})).toBe(false);
    expect(view.container.querySelectorAll(".chat-virtual-row")).toHaveLength(elements);

    const warmedKeys = new Set(prepared.map(([row]) => row.key));
    await view.scrollTo(120);
    const nextRows = transcriptRows(view.container);
    // The renderer mounts overscan too; leaving its edge rows cold still parses
    // Markdown in the next scroll frame even when the viewport is prepared.
    expect(nextRows.every((row) => warmedKeys.has(row.dataset.virtualRowKey!))).toBe(true);
  },
);

it("cancels queued scroll warming when the transcript is hidden", async () => {
  const view = await transcriptFixture(0, true, false, true);
  await view.scrollTo(60);
  await view.frame();
  await view.present(false);
  const rendered = view.renderRow.mock.calls.length;
  await view.task();
  expect(view.renderRow.mock.calls).toHaveLength(rendered);
});

it("keeps warming in the reader's direction through opposite size compensation", async () => {
  const view = await transcriptFixture(24_000, true, false, true);
  await view.scrollTo(180);
  await view.frame();
  await view.scrollTo(120.5);
  const first = transcriptRows(view.container)[0]!;
  const beforeResize = view.container.scrollTop;
  emitTranscriptResize(first, 800, 500);
  await settle();
  expect(view.container.scrollTop).toBeGreaterThan(beforeResize);
  const rendered = view.renderRow.mock.calls.length;
  await view.task();
  const warmed = view.renderRow.mock.calls
    .slice(rendered)
    .map(([row]) => (row.kind === "item" ? row.item : -1));
  expect(warmed.length).toBeGreaterThan(0);
  expect(Math.max(...warmed)).toBeLessThan(Number(first.dataset.index));

  await view.scrollTo(180);
  const afterDown = view.renderRow.mock.calls.length;
  await view.frame();
  await view.task();
  await view.frame();
  await view.task();
  const downward = view.renderRow.mock.calls
    .slice(afterDown)
    .map(([row]) => (row.kind === "item" ? row.item : -1));
  expect(downward.length).toBeGreaterThan(0);
  expect(Math.min(...downward)).toBeGreaterThan(180);
});

it("reuses a nearby completed row after scrolling away and back, with a bounded DOM cache", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  const first = view.container.querySelector('[data-virtual-row-key="fragment:5"]');
  expect(first).not.toBeNull();
  const preparations = () =>
    view.renderRow.mock.calls.filter(([row]) => row.key === "fragment:5").length;
  const initialPreparations = preparations();
  await view.scrollTo(8);
  await view.frame(3);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:5"]')).toBe(first);
  expect(first?.getAttribute("data-prepared-row")).toBe("true");
  expect(first?.hasAttribute("inert")).toBe(true);
  expect(first?.getAttribute("aria-hidden")).toBe("true");
  await view.scrollTo(0);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:5"]')).toBe(first);
  expect(first?.hasAttribute("data-prepared-row")).toBe(false);
  expect(first?.hasAttribute("inert")).toBe(false);
  expect(first?.hasAttribute("aria-hidden")).toBe(false);
  expect(preparations()).toBe(initialPreparations);
  await view.updateRow(5, 2005);
  expect(preparations()).toBe(initialPreparations + 1);
  expect(first?.textContent).toBe("Message 2005");
  await view.replaceRenderer();
  expect(first?.textContent).toBe("Updated 2005");

  for (let index = 16; index < 240; index += 8) {
    await view.scrollTo(index);
    await view.frame(2);
    expect(transcriptRows(view.container).length).toBeLessThan(32);
    expect(
      view.container.querySelector(`[data-virtual-row-key="fragment:${index}"]`),
    ).not.toBeNull();
  }
  expect(first?.isConnected).toBe(false);
});

it("pauses queued preparation while hidden and retires it on disconnect", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  await view.scrollTo(80);
  await view.present(false);
  const hiddenRows = transcriptRows(view.container);
  await view.frame(8);
  expect(transcriptRows(view.container)).toEqual(hiddenRows);

  await view.present(true);
  await view.frame(3);
  expect(transcriptRows(view.container).some((row) => !hiddenRows.includes(row))).toBe(true);
  await view.scrollTo(160);
  view.host.disconnect();
  await settle();
  expect(transcriptRows(view.container)).toHaveLength(0);
  await view.frame(8);
  expect(transcriptRows(view.container)).toHaveLength(0);
});

it("keeps parked row styles stable when an earlier row changes height", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  const parked = view.container.querySelector<HTMLElement>("[data-prepared-row]")!;
  const active = view.container.querySelector<HTMLElement>(
    ".chat-virtual-row:not([data-prepared-row])",
  )!;
  expect(Number(parked.dataset.index)).toBeGreaterThan(Number(active.dataset.index));
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(parked, { attributes: true, attributeFilter: ["style"] });
  try {
    emitTranscriptResize(active, 800, 200);
    await settle();
    mutations.push(...observer.takeRecords());
    expect(mutations).toHaveLength(0);
    expect(parked.isConnected).toBe(true);
  } finally {
    observer.disconnect();
  }
});

it("prepares ahead during scrolling and waits for measurement before admitting another row", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  await view.scrollTo(1);
  await view.frame();
  await view.scrollTo(4);
  const activeIndexes = () =>
    [...view.container.querySelectorAll<HTMLElement>("[data-index]:not([data-prepared-row])")].map(
      (row) => Number(row.dataset.index),
    );
  const rendered = view.renderRow.mock.calls.length;
  await view.frame(1, false);
  const preparedKey = view.renderRow.mock.calls.at(-1)?.[0].key;
  const preparing = view.container.querySelector<HTMLElement>(
    `[data-virtual-row-key="${preparedKey}"]`,
  );
  expect(preparing).not.toBeNull();
  expect(preparing!.getAttribute("data-preparing-row")).toBe("true");
  expect(view.container.querySelectorAll("[data-preparing-row]")).toHaveLength(1);
  expect(Number(preparing!.dataset.index)).toBeGreaterThan(Math.max(...activeIndexes()));
  expect(view.renderRow.mock.calls).toHaveLength(rendered + 1);
  await view.frame(2, false);
  expect(view.renderRow.mock.calls).toHaveLength(rendered + 1);
  emitTranscriptResize(preparing!, 800, 100);
  await settle();
  expect(view.container.querySelectorAll("[data-preparing-row]")).toHaveLength(0);
  await view.frame(1, false);
  expect(view.renderRow.mock.calls).toHaveLength(rendered + 2);
  expect(view.container.querySelectorAll("[data-preparing-row]")).toHaveLength(1);
});

it("places a fresh long transcript at its tail and warms a bounded upward window", async () => {
  const view = await transcriptFixture(null);
  await view.frame(8);
  expect(view.container.scrollTop).toBeGreaterThan(24_000);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:255"]')).not.toBeNull();
  expect(transcriptRows(view.container).every((row) => Number(row.dataset.index) > 230)).toBe(true);
  await view.frame(160);
  expect(transcriptRows(view.container).some((row) => Number(row.dataset.index) < 250)).toBe(true);
  expect(transcriptRows(view.container).length).toBeLessThanOrEqual(12);
  const preparations = view.renderRow.mock.calls.length;
  await view.frame(16);
  expect(view.renderRow.mock.calls).toHaveLength(preparations);
});

it("uses cached geometry on the first reader movement after tail placement", async () => {
  const view = await transcriptFixture(null, true);
  await view.frame(8);
  const style = vi.spyOn(globalThis, "getComputedStyle");
  await view.scrollTo(240);
  await view.frame(2, false);
  expect(
    style.mock.calls.filter(([element]) => element.classList.contains("chat-virtual-row")),
  ).toHaveLength(0);
});

it("materializes one predicted row between scroll frames and uses the latest viewport", async () => {
  const view = await transcriptFixture(0, true, false, "retained");
  await view.scrollTo(3);
  const mounted = transcriptRows(view.container);
  await view.task();
  expect(transcriptRows(view.container)).toEqual(mounted);
  await view.frame(1, false);
  await view.task();
  expect(transcriptRows(view.container)).toEqual(mounted);
  const warmed = view.renderRow.mock.calls.length;
  await view.task();
  expect(view.renderRow.mock.calls).toHaveLength(warmed);
  await view.frame(1, false);
  await view.task();
  const prepared = transcriptRows(view.container).find((row) => !mounted.includes(row));
  expect(prepared).toBeDefined();
  expect(prepared!.getAttribute("data-preparing-row")).toBe("true");
  expect(Number(prepared!.dataset.index)).toBeGreaterThan(3);
  await view.frame(1, false);
  await view.task();
  expect(transcriptRows(view.container)).toHaveLength(mounted.length + 1);

  emitTranscriptResize(prepared!, 800, 100);
  await settle();
  await view.scrollTo(6);
  const afterScroll = transcriptRows(view.container);
  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();
  const next = transcriptRows(view.container).find((row) => !afterScroll.includes(row));
  expect(next).toBeDefined();
  expect(Number(next!.dataset.index)).toBeGreaterThan(6);
});

it("stops preparing when the predicted DOM window has no retainable rows", async () => {
  const view = await transcriptFixture(0, true, false, true);
  await view.updateRow(24, 24);
  await view.scrollTo(10);
  await view.frame();
  await view.scrollTo(15);
  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();
  const rendered = view.renderRow.mock.calls.length;
  await view.frame(1, false);
  await view.task();
  expect(view.renderRow.mock.calls).toHaveLength(rendered);
});

it("warms arriving Markdown without speculative mounts during viewport-sized scroll steps", async () => {
  const view = await transcriptFixture(0, true, false, "retained");
  await view.scrollTo(60);
  const mounted = transcriptRows(view.container);
  const rendered = view.renderRow.mock.calls.length;
  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();
  expect(view.renderRow.mock.calls.length).toBeGreaterThan(rendered);
  expect(transcriptRows(view.container)).toEqual(mounted);
});

it("prepares inward when fast upward prediction reaches an ordinary first row", async () => {
  const view = await transcriptFixture(24_000, true, true);
  await view.scrollTo(8);
  await view.frame(2);
  await view.scrollTo(4);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:1"]')).toBeNull();

  await view.frame(1, false);
  await view.task();
  await view.frame(1, false);
  await view.task();

  const firstFragment = view.container.querySelector('[data-virtual-row-key="fragment:1"]');
  expect(firstFragment).not.toBeNull();
  expect(firstFragment?.getAttribute("data-prepared-row")).toBe("true");
  expect(view.container.scrollTop).toBe(400);
});

it("shares calendar formatting within one row mounting batch", async () => {
  await Promise.resolve();
  const timestamp = Date.UTC(2026, 9, 25, 12, 34, 56);
  const label = new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const format = vi.spyOn(Intl, "DateTimeFormat");
  const legacyFormat = vi.spyOn(Date.prototype, "toLocaleString");
  const formattingSetups = () => format.mock.calls.length + legacyFormat.mock.calls.length;
  const mount = () => {
    const view = mountSolid<Parameters<typeof ChatTimestamp>[0]>(ChatTimestamp, {
      timestamp,
    });
    disposers.push(view.dispose);
    expect(view.container.querySelector("openclaw-tooltip")).toHaveProperty("content", label);
  };
  mount();
  mount();
  expect(formattingSetups()).toBe(1);
  await Promise.resolve();
  mount();
  expect(formattingSetups()).toBe(2);
});

it("formats the detailed timestamp only when metadata becomes available", () => {
  const format = vi
    .spyOn(Date.prototype, "toLocaleString")
    .mockImplementation((_, options) =>
      options?.weekday === "long"
        ? "Sunday, October 25, 2026 at 12:34:56 PM UTC"
        : "Oct 25, 2026, 12:34 PM UTC",
    );
  const timestamp = Date.UTC(2026, 9, 25, 12, 34, 56);
  const view = mountSolid<Parameters<typeof ChatTimestamp>[0]>(ChatTimestamp, { timestamp });
  disposers.push(view.dispose);
  const detailedCalls = () =>
    format.mock.calls.filter(([, options]) => options?.weekday === "long");
  expect(detailedCalls()).toHaveLength(0);
  expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-10-25T12:34:56.000Z",
  );

  view.update({ timestamp, metadata: [<span>42 tokens</span>] });
  expect(detailedCalls()).toHaveLength(1);
  const summary = view.container.querySelector("button.msg-meta__summary");
  expect(summary?.getAttribute("aria-label")).toBe(
    "Message context for Sunday, October 25, 2026 at 12:34:56 PM UTC",
  );
  view.update({ timestamp, metadata: [<span>84 tokens</span>] });
  expect(detailedCalls()).toHaveLength(1);
  expect(view.container.textContent).toContain("84 tokens");
});

it("advances a relative timestamp without refreshing its message", async () => {
  const now = Date.UTC(2026, 9, 26, 12);
  vi.useFakeTimers({ now });
  try {
    const view = mountSolid<Parameters<typeof ChatTimestamp>[0]>(ChatTimestamp, {
      timestamp: now - 60_000,
    });
    disposers.push(view.dispose);
    const time = view.container.querySelector("time");
    expect(time?.textContent).toBe("1m ago");

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(view.container.querySelector("time")).toBe(time);
    expect(time?.textContent).toBe("2m ago");
  } finally {
    vi.useRealTimers();
  }
});

it("updates the settled scroll window without re-entering the caller renderer", async () => {
  const view = await transcriptFixture(0, true);
  await view.frame(8);
  const draws = view.draw.mock.calls.length;
  await view.scrollTo(120);
  expect(view.draw.mock.calls).toHaveLength(draws);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:120"]')).not.toBeNull();
  expect(view.container.scrollTop).toBe(12_000);
});
