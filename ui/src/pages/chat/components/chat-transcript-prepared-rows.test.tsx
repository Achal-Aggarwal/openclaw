/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
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

async function transcriptFixture(initialOffset: number | null = 0, idlePreparation = false) {
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
  const container = document.body.appendChild(document.createElement("div"));
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(host.contentElement?.style.height ?? "0") || 0,
    },
  });
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      container.scrollTop = Math.max(
        0,
        Math.min(options.top ?? container.scrollTop, container.scrollHeight - 600),
      );
    }
  };
  const rows: TranscriptRow<number>[] = Array.from({ length: 256 }, (_, index) => ({
    kind: "item",
    key: `fragment:${index}`,
    item: index,
    estimatedSize: 100,
  }));
  let presented = true;
  let queued = false;
  let disposed = false;
  const renderRow = vi.fn((row: TranscriptRow<number>) => (
    <span>Message {row.kind === "item" ? row.item : ""}</span>
  ));
  let renderer = renderRow;
  const draw = () => {
    const root = host.render(rows, renderer, null, false, null, null, presented);
    if (root.parentElement !== container) {
      container.append(root);
    }
    host.update();
    flush();
  };
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
    renderRow,
    async updateRow(index: number, item: number) {
      rows[index] = { kind: "item", key: `fragment:${index}`, item, estimatedSize: 100 };
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

it("reuses a recent completed row after scrolling away and back, with a bounded DOM cache", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  const first = view.container.querySelector('[data-virtual-row-key="fragment:2"]');
  expect(first).not.toBeNull();
  const preparations = () =>
    view.renderRow.mock.calls.filter(([row]) => row.key === "fragment:2").length;
  const initialPreparations = preparations();
  await view.scrollTo(24);
  await view.frame(3);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:2"]')).toBe(first);
  expect(first?.getAttribute("data-prepared-row")).toBe("true");
  expect(first?.hasAttribute("inert")).toBe(true);
  expect(first?.getAttribute("aria-hidden")).toBe("true");
  await view.scrollTo(0);
  expect(view.container.querySelector('[data-virtual-row-key="fragment:2"]')).toBe(first);
  expect(first?.hasAttribute("data-prepared-row")).toBe(false);
  expect(first?.hasAttribute("inert")).toBe(false);
  expect(first?.hasAttribute("aria-hidden")).toBe(false);
  expect(preparations()).toBe(initialPreparations);
  await view.updateRow(2, 2002);
  expect(preparations()).toBe(initialPreparations + 1);
  expect(first?.textContent).toBe("Message 2002");
  await view.replaceRenderer();
  expect(first?.textContent).toBe("Updated 2002");

  for (let index = 16; index < 240; index += 8) {
    await view.scrollTo(index);
    await view.frame(2);
    expect(transcriptRows(view.container).length).toBeLessThan(144);
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
  expect(transcriptRows(view.container).length).toBeGreaterThan(hiddenRows.length);
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

it("prepares ahead during fast scrolling and waits for measurement before admitting another row", async () => {
  const view = await transcriptFixture();
  await view.frame(8);
  await view.scrollTo(1);
  await view.frame();
  await view.scrollTo(60);
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
  expect(transcriptRows(view.container).some((row) => Number(row.dataset.index) < 160)).toBe(true);
  expect(transcriptRows(view.container).length).toBeLessThanOrEqual(128);
  const preparations = view.renderRow.mock.calls.length;
  await view.frame(16);
  expect(view.renderRow.mock.calls).toHaveLength(preparations);
});

it("waits for idle time to prepare during scrolling and uses the latest viewport", async () => {
  const view = await transcriptFixture(0, true);
  const scheduled = vi.mocked(requestIdleCallback).mock.calls.length;
  await view.scrollTo(60);
  expect(vi.mocked(requestIdleCallback).mock.calls).toHaveLength(scheduled);
  expect(cancelIdleCallback).not.toHaveBeenCalled();
  const rendered = view.renderRow.mock.calls.length;
  await view.frame(2);
  expect(view.renderRow.mock.calls).toHaveLength(rendered);
  await view.idle(2);
  expect(view.renderRow.mock.calls).toHaveLength(rendered);
  await view.idle();
  expect(view.renderRow.mock.calls).toHaveLength(rendered + 1);

  const nextScheduled = vi.mocked(requestIdleCallback).mock.calls.length;
  await view.scrollTo(120);
  expect(vi.mocked(requestIdleCallback).mock.calls).toHaveLength(nextScheduled);
  expect(cancelIdleCallback).not.toHaveBeenCalled();
  const afterScroll = view.renderRow.mock.calls.length;
  await view.frame(2);
  expect(view.renderRow.mock.calls).toHaveLength(afterScroll);
  await view.idle();
  expect(view.renderRow.mock.calls).toHaveLength(afterScroll + 1);
  const prepared = view.renderRow.mock.calls.at(-1)![0];
  expect(prepared.kind === "item" && prepared.item).toBeGreaterThan(120);
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
