import type { Range, Virtualizer } from "@tanstack/virtual-core";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { transcriptOverscan } from "./chat-transcript-range.ts";
import { CHAT_TRANSCRIPT_OVERSCAN } from "./chat-transcript-session.ts";

/** Own initial tail placement and bounded preparation ahead of the visible range. */
export class TranscriptInitialRange {
  pending = true;
  private tailRows: number;
  private viewportOnly = false;
  private preparingOverscan = false;
  overscan = CHAT_TRANSCRIPT_OVERSCAN;
  private rows: readonly TranscriptRow[] = [];
  // Completed fragments have no widget custody. Retain their keyed DOM while
  // keeping inactive rows outside the visible range's flow.
  readonly preparedRowKeys = new Set<string>();
  private preparingRowKey: string | undefined;
  readonly rowIndexes = new Map<string, number>();
  private cancelPreparation?: () => void;
  private preparationIsIdle = false;
  private prepareStarted = 0;
  private prepareLatency = 16;
  private scrollSample = { offset: 0, time: 0, velocity: 0, direction: -1 };
  get measuring(): boolean {
    return this.pending || this.preparingOverscan;
  }

  constructor(
    initialOffset: number | null,
    private readonly virtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly normalRange: (range: Range, indexes: ReadonlyMap<string, number>) => number[],
    private readonly invalidate: () => void,
    private readonly canPrepare: () => boolean,
    private readonly measure: (
      element: HTMLElement,
      entry: ResizeObserverEntry | undefined,
    ) => number,
  ) {
    this.tailRows = initialOffset === null ? 1 : 0;
  }

  extract(range: Range): number[] {
    if (!this.tailRows) {
      const indexes = new Set(
        this.normalRange(this.viewportOnly ? { ...range, overscan: 0 } : range, this.rowIndexes),
      );
      for (const key of this.preparedRowKeys) {
        const index = this.rowIndexes.get(key);
        if (index !== undefined) {
          indexes.add(index);
        }
      }
      return [...indexes].toSorted((left, right) => left - right);
    }
    const count = Math.min(range.count, this.tailRows);
    return Array.from({ length: count }, (_, index) => range.count - count + index);
  }

  presentation(rows: readonly TranscriptRow[]) {
    this.rows = rows;
    this.retainViewportRows();
    return {
      activeRowKeys: new Set(this.activeIndexes().map((index) => rows[index]!.key)),
    };
  }

  private activeIndexes(): number[] {
    const virtualizer = this.virtualizer();
    if (this.tailRows) {
      return virtualizer.getVirtualItems().map((row) => row.index);
    }
    const range = virtualizer.calculateRange();
    return range
      ? this.normalRange(
          {
            ...range,
            count: virtualizer.options.count,
            overscan: this.viewportOnly ? 0 : virtualizer.options.overscan,
          },
          this.rowIndexes,
        )
      : [];
  }

  private refresh(): void {
    const virtualizer = this.virtualizer();
    virtualizer.setOptions({
      ...virtualizer.options,
      // Range extraction is memoized by function identity, independently of row measurements.
      rangeExtractor: (range) => this.extract(range),
    });
  }

  extend(element: HTMLDivElement): boolean {
    const virtualizer = this.virtualizer();
    if (
      !(
        this.tailRows > 0 &&
        this.tailRows < virtualizer.options.count &&
        virtualizer.getVirtualItems().reduce((height, row) => height + row.size, 0) +
          (Number.parseFloat(getComputedStyle(element).paddingBottom) || 0) <
          element.clientHeight
      )
    ) {
      return false;
    }
    // One preceding row avoids preparing and discarding expensive Markdown on estimates.
    this.tailRows += 1;
    this.refresh();
    return true;
  }

  finish(viewportOnly = false): void {
    this.pending = false;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = undefined;
    if (!this.tailRows && !this.viewportOnly) {
      return;
    }
    this.preparingOverscan = this.viewportOnly && !viewportOnly;
    // The measured viewport stays adaptive; offscreen rows wait for reader navigation.
    this.tailRows = 0;
    this.viewportOnly = viewportOnly;
    this.refresh();
    this.invalidate();
  }

  complete(): void {
    if (this.pending) {
      this.finish(true);
    } else {
      this.preparingOverscan = false;
    }
  }

  updateRows(rows: readonly TranscriptRow[]): void {
    const indexes = this.rowIndexes;
    indexes.clear();
    rows.forEach((row, index) => indexes.set(row.key, index));
    this.overscan = transcriptOverscan(rows);
    for (const key of this.preparedRowKeys) {
      const index = indexes.get(key);
      if (index === undefined || rows[index]?.estimatedSize === undefined) {
        this.preparedRowKeys.delete(key);
      }
    }
    if (this.preparingRowKey && !this.preparedRowKeys.has(this.preparingRowKey)) {
      this.preparingRowKey = undefined;
      this.prepareStarted = 0;
    }
  }

  didCommit(): void {
    this.queuePreparation();
  }

  readonly measureElement = (
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
  ): number => {
    const size = this.measure(element, entry);
    const key = element.dataset.virtualRowKey;
    if (
      key === this.preparingRowKey &&
      (entry || !this.virtualizer().targetWindow?.ResizeObserver)
    ) {
      // This is readiness latency, including layout, rather than CPU time.
      this.prepareLatency = Math.max(1, performance.now() - this.prepareStarted);
      this.prepareStarted = 0;
      queueMicrotask(() => {
        if (this.preparingRowKey === key) {
          this.preparingRowKey = undefined;
          this.queuePreparation();
        }
      });
    }
    return size;
  };

  private retainViewportRows(): void {
    const virtualizer = this.virtualizer();
    const range = virtualizer.range;
    if (!range || this.pending) {
      return;
    }
    const now = performance.now();
    const offset = virtualizer.scrollOffset ?? 0;
    const previous = this.scrollSample;
    if (offset !== previous.offset) {
      if (this.preparationIsIdle) {
        this.cancelPreparation?.();
        this.cancelPreparation = undefined;
        this.preparationIsIdle = false;
      }
      const delta = offset - previous.offset;
      this.scrollSample = {
        offset,
        time: now,
        velocity: previous.time ? Math.abs(delta) / Math.max(16, now - previous.time) : 0,
        direction: Math.sign(delta),
      };
    }
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const row = this.rows[index];
      if (row?.estimatedSize !== undefined) {
        this.preparedRowKeys.delete(row.key);
        this.preparedRowKeys.add(row.key);
      }
    }
    // The recent viewport wins over speculative preparation; geometry stays in
    // virtual-core's size cache even after the bounded DOM cache evicts a row.
    while (this.preparedRowKeys.size > 32) {
      this.preparedRowKeys.delete(this.preparedRowKeys.keys().next().value!);
    }
  }

  private queuePreparation(): void {
    if (
      this.cancelPreparation ||
      this.preparingRowKey ||
      this.overscan !== 0 ||
      this.pending ||
      this.tailRows > 0 ||
      !this.canPrepare()
    ) {
      return;
    }
    const prepare = (deadline: number) => {
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
      if (performance.now() >= deadline) {
        this.queuePreparation();
        return;
      }
      const virtualizer = this.virtualizer();
      const range = virtualizer.range;
      if (!this.canPrepare() || !range || !virtualizer.scrollElement || this.prepareStarted) {
        return;
      }
      const rows = this.rows;
      const direction = this.scrollSample.direction;
      const viewport = virtualizer.scrollRect?.height ?? 600;
      const velocity =
        performance.now() - this.scrollSample.time < 100 ? this.scrollSample.velocity : 0;
      // At speed, prepare the next viewport rather than rows the reader skips.
      // Virtual-core resolves this from cached sizes; no neighbor layout reads.
      const predictedOffset =
        (virtualizer.scrollOffset ?? 0) +
        direction * velocity * (16 + this.prepareLatency) +
        (direction > 0 ? viewport : 0);
      const predicted = virtualizer.getVirtualItemForOffset(Math.max(0, predictedOffset));
      const origin =
        velocity && predicted
          ? predicted.index - direction
          : direction > 0
            ? range.endIndex
            : range.startIndex;
      const rendered = new Set(virtualizer.getVirtualItems().map((row) => row.key));
      let admitted = 0;
      for (let step = 1; step <= 8 && admitted === 0; step++) {
        const index = origin + step * direction;
        const row = rows?.[index];
        if (
          row?.estimatedSize !== undefined &&
          !rendered.has(row.key) &&
          !this.preparedRowKeys.has(row.key)
        ) {
          if (performance.now() >= deadline) {
            this.queuePreparation();
            return;
          }
          this.preparedRowKeys.add(row.key);
          this.preparingRowKey = row.key;
          admitted++;
        }
      }
      if (!admitted) {
        return;
      }
      this.prepareStarted = performance.now();
      virtualizer.setOptions({
        ...virtualizer.options,
        rangeExtractor: (next) => this.extract(next),
      });
      this.invalidate();
    };
    if (typeof requestIdleCallback === "function") {
      const idleRequest = requestIdleCallback(
        (idle) => prepare(performance.now() + (idle.timeRemaining() >= 6 ? 6 : 0)),
        { timeout: 250 },
      );
      this.preparationIsIdle = true;
      this.cancelPreparation = () => cancelIdleCallback(idleRequest);
    } else {
      // Admit one atomic fragment early in the frame, then await its measurement.
      // The fragment itself can overrun this six-millisecond admission budget.
      const frame = requestAnimationFrame((time) => prepare(time + 6));
      this.cancelPreparation = () => cancelAnimationFrame(frame);
    }
  }

  disconnect(): void {
    this.cancelPreparation?.();
    this.cancelPreparation = undefined;
    this.preparationIsIdle = false;
    this.prepareStarted = 0;
    this.preparingRowKey = undefined;
    this.preparedRowKeys.clear();
    this.refresh();

    this.preparingOverscan = false;
    if (!this.pending && (this.tailRows || this.viewportOnly)) {
      this.tailRows = 0;
      this.viewportOnly = false;
      this.refresh();
    }
  }
}
