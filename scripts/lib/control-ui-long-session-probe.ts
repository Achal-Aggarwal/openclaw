import { closeSync, openSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

const paneSelector = ".chat-pane-cache__pane--active";
const needle = "long-session-search-needle";
const cpuMetrics = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];

/** Caller owns the production server, synthetic fixture, and enabled Performance CDP domain. */
export async function probeLongSession(options: {
  page: Page;
  cdp: CDPSession;
  artifactDir: string;
  prefix: string;
  sessionKey: string;
  otherSessionKey: string;
  captureHeap?: boolean;
}) {
  const {
    page,
    cdp,
    artifactDir,
    prefix,
    sessionKey,
    otherSessionKey,
    captureHeap = true,
  } = options;
  const pane = page.locator(paneSelector);
  const composer = pane.locator(".agent-chat__composer-combobox textarea");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((entry) => [entry.name, entry.value]),
    );
  const readRpcs = () =>
    page.evaluate(() => {
      // SAFETY: The caller's cold-load init script installs this reader before navigation.
      const probe = Reflect.get(window, "__coldLoad") as {
        read(): { rpcs: Array<{ method: string; ms: number }> };
      };
      return probe.read().rpcs;
    });
  const visible = (key: string) =>
    page.waitForFunction(
      ({ selector, key: targetKey }) => {
        const active = document.querySelector(selector);
        if (!active) {
          return false;
        }
        const host = active.matches("openclaw-chat-pane")
          ? active
          : active.querySelector("openclaw-chat-pane");
        const viewport = active.querySelector(".chat-thread")?.getBoundingClientRect();
        return (
          host &&
          Reflect.get(host, "sessionKey") === targetKey &&
          viewport &&
          [...active.querySelectorAll<HTMLElement>(".chat-virtual-row")].some((row) => {
            const rect = row.getBoundingClientRect();
            return (
              row.checkVisibility() && rect.bottom > viewport.top && rect.top < viewport.bottom
            );
          })
        );
      },
      { selector: paneSelector, key },
    );
  const ready = async (key: string) => {
    await visible(key);
    await composer.waitFor({ state: "visible" });
    await page.waitForFunction((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        `${selector} .agent-chat__composer-combobox textarea`,
      );
      return input && !input.disabled && !input.readOnly;
    }, paneSelector);
    await composer.focus();
    if (!(await composer.evaluate((input) => input === document.activeElement))) {
      throw new Error("Long-session composer did not accept focus");
    }
  };
  const measure = async <T>(action: () => Promise<T>) => {
    const before = await metrics();
    const rpcOffset = (await readRpcs()).length;
    const start = await page.evaluate(() => performance.now());
    const result = await action();
    const elapsedMs = await page.evaluate((origin) => performance.now() - origin, start);
    const after = await metrics();
    return {
      elapsedMs,
      milliseconds: Object.fromEntries(
        cpuMetrics.map((name) => {
          if (before[name] === undefined || after[name] === undefined) {
            throw new Error(`Missing CDP metric: ${name}`);
          }
          return [name, (after[name] - before[name]) * 1000];
        }),
      ),
      rpcs: (await readRpcs()).slice(rpcOffset),
      result,
    };
  };
  const memory = async (stage: string) => {
    const before = { metrics: await metrics(), dom: await cdp.send("Memory.getDOMCounters") };
    await cdp.send("HeapProfiler.collectGarbage");
    const after = { metrics: await metrics(), dom: await cdp.send("Memory.getDOMCounters") };
    const counts = await pane.evaluate((active) => ({
      documentElements: document.querySelectorAll("*").length,
      transcriptElements: active.querySelectorAll(".chat-thread *").length,
      renderedRows: active.querySelectorAll(".chat-virtual-row").length,
    }));
    if (!captureHeap) {
      return {
        beforeGc: before,
        afterGc: after,
        ...counts,
        detachedNodes: null,
        detachedBytes: null,
        heapSnapshot: null,
      };
    }
    const file = path.join(artifactDir, `${prefix}.${stage}.heapsnapshot`);
    const fd = openSync(file, "wx");
    const onChunk = ({ chunk }: { chunk: string }) => writeSync(fd, chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { exposeInternals: true });
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      closeSync(fd);
    }
    // SAFETY: This file is the unmodified heap snapshot just emitted by this CDP session.
    const heap = JSON.parse(await readFile(file, "utf8")) as {
      snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } };
      nodes: number[];
    };
    const fields = heap.snapshot.meta.node_fields;
    const typeAt = fields.indexOf("type");
    const sizeAt = fields.indexOf("self_size");
    const types = heap.snapshot.meta.node_types[typeAt];
    const detachedAt = fields.indexOf("detachedness");
    if (!Array.isArray(types) || detachedAt < 0 || typeAt < 0 || sizeAt < 0) {
      throw new Error("Heap snapshot lacks DOM detachedness");
    }
    let detachedNodes = 0;
    let detachedBytes = 0;
    for (let index = 0; index < heap.nodes.length; index += fields.length) {
      if (types[heap.nodes[index + typeAt]!] === "native" && heap.nodes[index + detachedAt] === 2) {
        detachedNodes++;
        detachedBytes += heap.nodes[index + sizeAt]!;
      }
    }
    return {
      beforeGc: before,
      afterGc: after,
      ...counts,
      detachedNodes,
      detachedBytes,
      heapSnapshot: file,
    };
  };
  await ready(sessionKey);
  const initialMemory = await memory("initial");
  const switchTo = (key: string) =>
    measure(async () => {
      const link = page.locator(
        `.sidebar-recent-session[data-session-key=${JSON.stringify(key)}] a.sidebar-recent-session__link`,
      );
      await link.waitFor({ state: "visible" });
      const start = await page.evaluate(() => performance.now());
      await link.click();
      await visible(key);
      const visibleMs = await page.evaluate((origin) => performance.now() - origin, start);
      await ready(key);
      return { sessionKey: key, visibleMs };
    });
  const switchOut = await switchTo(otherSessionKey);
  const switchIn = await switchTo(sessionKey);
  const search = await measure(async () => {
    const shortcut = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
    );
    await page.keyboard.press(shortcut);
    const input = pane.getByRole("textbox", { name: "Search messages", exact: true });
    await input.fill(needle);
    await pane
      .locator(".chat-thread")
      .getByText(needle, { exact: false })
      .first()
      .waitFor({ state: "visible" });
    return { query: needle, renderedRows: await pane.locator(".chat-virtual-row").count() };
  });
  await page.screenshot({ path: path.join(artifactDir, `${prefix}.search.png`) });
  const clearSearch = await measure(async () => {
    await pane.getByRole("button", { name: "Close search", exact: true }).click();
    await pane.locator(".agent-chat__search-bar").waitFor({ state: "detached" });
    await ready(sessionKey);
  });
  const scroll = (direction: "top" | "bottom") =>
    measure(() =>
      pane.locator(".chat-thread").evaluate(async (thread, destination) => {
        if (!(thread instanceof HTMLElement)) {
          throw new Error("Transcript is not an HTML scroll element");
        }
        const scroller = thread;
        const longTasks: Array<{ startMs: number; durationMs: number }> = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          }
        });
        observer.observe({ type: "longtask" });
        const frames: Array<{
          intervalMs: number;
          coverage: number;
          rows: number;
          scrollTop: number;
          scrollHeight: number;
        }> = [];
        let previous = performance.now();
        const startTop = scroller.scrollTop;
        try {
          for (let frame = 0; frame <= 60; frame++) {
            const now = await new Promise<number>(requestAnimationFrame);
            const viewport = scroller.getBoundingClientRect();
            const rows = [...scroller.querySelectorAll<HTMLElement>(".chat-virtual-row")];
            const segments = rows
              .map((row) => row.getBoundingClientRect())
              .map(
                (rect) =>
                  [
                    Math.max(viewport.top, rect.top),
                    Math.min(viewport.bottom, rect.bottom),
                  ] as const,
              )
              .filter(([top, bottom]) => bottom > top)
              .toSorted((a, b) => a[0] - b[0]);
            let covered = 0;
            let end = viewport.top;
            for (const [top, bottom] of segments) {
              covered += Math.max(0, bottom - Math.max(top, end));
              end = Math.max(end, bottom);
            }
            frames.push({
              intervalMs: now - previous,
              coverage: covered / viewport.height,
              rows: rows.length,
              scrollTop: scroller.scrollTop,
              scrollHeight: scroller.scrollHeight,
            });
            previous = now;
            if (frame < 60) {
              const target =
                destination === "top" ? 0 : scroller.scrollHeight - scroller.clientHeight;
              scroller.scrollTop = startTop + ((target - startTop) * (frame + 1)) / 60;
            }
          }
          await new Promise(requestAnimationFrame);
          for (const entry of observer.takeRecords()) {
            longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          }
        } finally {
          observer.disconnect();
        }
        const distance =
          destination === "top"
            ? scroller.scrollTop
            : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        if (distance > 2) {
          throw new Error(`Scroll did not reach ${destination}: ${distance}px remaining`);
        }
        return {
          direction: destination,
          frames,
          longTasks,
          maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.durationMs)),
          blankFrames: frames.filter((frame) => frame.coverage === 0).length,
          maxRows: Math.max(...frames.map((frame) => frame.rows)),
          frameGapsOver50Ms: frames.filter((frame) => frame.intervalMs > 50).length,
          estimatedDroppedFrames60Hz: frames.reduce(
            (sum, frame) => sum + Math.max(0, Math.round(frame.intervalMs / (1000 / 60)) - 1),
            0,
          ),
        };
      }, direction),
    );
  const scrollTop = await scroll("top");
  const scrollBottom = await scroll("bottom");
  const finalMemory = await memory("after-scroll");
  await page.screenshot({ path: path.join(artifactDir, `${prefix}.bottom.png`) });
  const report = {
    measurement:
      "Synthetic production UI; automation-to-visible/focus wall time, CDP duration deltas, 60-frame native scrollTop trajectories. Geometric row coverage is not compositor paint proof. Heap snapshots and explicit GC are outside action timings. CPU includes measurement overhead; compare paired runs with identical instrumentation.",
    sessionKey,
    otherSessionKey,
    initialMemory,
    switchOut,
    switchIn,
    search,
    clearSearch,
    scrollTop,
    scrollBottom,
    finalMemory,
  };
  await writeFile(
    path.join(artifactDir, `${prefix}.long-session.json`),
    JSON.stringify(report, null, 2),
  );
  return report;
}
