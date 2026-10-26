import type { Range, Virtualizer } from "@tanstack/virtual-core";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

// A few viewports avoid repeat mounts without making every scroll restyle a
// large parked subtree. Geometry and prepared Markdown outlive DOM eviction.
const PREPARED_ROW_LIMIT = 12;

/** Own initial tail placement and bounded preparation ahead of the visible range. */
export class TranscriptInitialRange {
  pending = true;
  private tailRows: number;
  private rows: readonly TranscriptRow[] = [];
  // Completed text rows have no widget custody. Retain their keyed DOM while
  // keeping inactive rows outside the visible range's flow.
  readonly preparedRowKeys = new Set<string>();
  private preparingRowKey: string | undefined;
  readonly rowIndexes = new Map<string, number>();
  private cancelPreparation?: () => void;
  private preparationIsIdle = false;
  private prepareStarted = 0;
  private prepareLatency = 16;
  private scrollSample = { time: 0, distance: 0, velocity: 0, direction: -1 };
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
    private readonly prewarmRow?: (index: number) => boolean,
  ) {
    this.tailRows = initialOffset === null ? 1 : 0;
  }

  extract(range: Range): number[] {
    if (!this.tailRows) {
      const indexes = new Set(this.normalRange(range, this.rowIndexes));
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
      preparingRowKey: this.preparingRowKey,
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
            overscan: virtualizer.options.overscan,
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

  finish(): void {
    this.pending = false;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = undefined;
    if (!this.tailRows) {
      return;
    }
    // The measured viewport stays adaptive; offscreen rows wait for reader navigation.
    this.tailRows = 0;
    this.refresh();
    this.invalidate();
  }

  complete(): void {
    if (this.pending) {
      this.finish();
    }
  }

  updateRows(rows: readonly TranscriptRow[]): void {
    const indexes = this.rowIndexes;
    indexes.clear();
    rows.forEach((row, index) => indexes.set(row.key, index));
    for (const key of this.preparedRowKeys) {
      const index = indexes.get(key);
      if (index === undefined || !rows[index]?.retainDom) {
        this.preparedRowKeys.delete(key);
      }
    }
    if (this.preparingRowKey && !this.preparedRowKeys.has(this.preparingRowKey)) {
      this.preparingRowKey = undefined;
      this.prepareStarted = 0;
    }
  }

  didCommit(): void {
    if (this.preparationIsIdle && this.virtualizer().isScrolling) {
      this.cancelPreparation?.();
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
    }
    this.queuePreparation();
  }

  recordReaderMovement(delta: number): void {
    const now = performance.now();
    const previous = this.scrollSample;
    this.scrollSample = {
      time: now,
      distance: Math.abs(delta),
      velocity: previous.time ? Math.abs(delta) / Math.max(16, now - previous.time) : 0,
      direction: Math.sign(delta),
    };
    this.finish();
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
          this.invalidate();
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
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const row = this.rows[index];
      if (row?.retainDom) {
        this.preparedRowKeys.delete(row.key);
        this.preparedRowKeys.add(row.key);
      }
    }
    // The recent viewport wins over speculative preparation; geometry stays in
    // virtual-core's size cache even after the bounded DOM cache evicts a row.
    while (this.preparedRowKeys.size > PREPARED_ROW_LIMIT) {
      this.preparedRowKeys.delete(this.preparedRowKeys.keys().next().value!);
    }
  }

  private queuePreparation(idleOnly = false): void {
    if (
      this.cancelPreparation ||
      this.preparingRowKey ||
      this.pending ||
      this.tailRows > 0 ||
      !this.canPrepare()
    ) {
      return;
    }
    const prepare = (deadline: number, prewarm = false, warmOnly = false) => {
      this.cancelPreparation = undefined;
      this.preparationIsIdle = false;
      if (performance.now() >= deadline) {
        this.queuePreparation(!warmOnly);
        return;
      }
      const virtualizer = this.virtualizer();
      const range = virtualizer.range;
      if (!this.canPrepare() || !range || !virtualizer.scrollElement || this.prepareStarted) {
        return;
      }
      const rows = this.rows;
      const sampledDirection = this.scrollSample.direction;
      // Initial placement and size compensation can point beyond an edge.
      // Idle work there prepares inward, where the reader can actually go.
      const inward =
        (sampledDirection > 0 && range.endIndex === rows.length - 1) ||
        (sampledDirection < 0 && range.startIndex === 0);
      const direction = inward ? -sampledDirection : sampledDirection;
      const viewport = virtualizer.scrollRect?.height ?? 600;
      const moving = !inward && performance.now() - this.scrollSample.time < 100;
      const velocity = moving ? this.scrollSample.velocity : 0;
      // HTML warming is synchronous: predict one observed scroll step and walk
      // into that viewport, rather than beyond its leading edge.
      const distance = moving
        ? warmOnly
          ? this.scrollSample.distance
          : velocity * (16 + this.prepareLatency)
        : 0;
      // At speed, prepare the next viewport rather than rows the reader skips.
      // Virtual-core resolves this from cached sizes; no neighbor layout reads.
      const predictedTop = Math.max(
        0,
        Math.min(
          (virtualizer.scrollOffset ?? 0) + direction * distance,
          Math.max(0, virtualizer.getTotalSize() - viewport),
        ),
      );
      const predictedOffset =
        predictedTop + ((warmOnly ? direction < 0 : direction > 0) ? viewport : 0);
      const predicted = virtualizer.getVirtualItemForOffset(Math.max(0, predictedOffset));
      // Prediction can reach an edge before the viewport. Prepare back into the
      // transcript instead of searching past an ordinary, nonfragment edge row.
      let searchDirection = direction;
      if (!warmOnly && distance && predicted) {
        if (predicted.index === 0) {
          searchDirection = 1;
        } else if (predicted.index === rows.length - 1) {
          searchDirection = -1;
        }
      }
      const origin =
        distance && predicted
          ? predicted.index - searchDirection
          : direction > 0
            ? range.endIndex
            : range.startIndex;
      const rendered = new Set(virtualizer.getVirtualItems().map((row) => row.key));
      // Warming covers the predicted viewport, whose row count varies with
      // measured heights. A fixed candidate cap left its last rows cold.
      const opposite =
        warmOnly && distance
          ? virtualizer.getVirtualItemForOffset(predictedTop + (direction > 0 ? viewport : 0))
          : undefined;
      const domLookahead =
        velocity || warmOnly ? 8 : Math.max(0, PREPARED_ROW_LIMIT - this.activeIndexes().length);
      const lookahead =
        opposite && predicted
          ? Math.abs(opposite.index - predicted.index) + 1
          : prewarm
            ? Math.max(8, domLookahead)
            : domLookahead;
      let admitted = 0;
      let warmed = false;
      for (let step = 1; step <= lookahead && admitted === 0; step++) {
        if (performance.now() >= deadline) {
          this.queuePreparation(!warmOnly);
          return;
        }
        const index = origin + step * searchDirection;
        const row = rows?.[index];
        if (row && prewarm && !rendered.has(row.key) && this.prewarmRow?.(index)) {
          // The shared cache owns readiness; no DOM or range invalidation is needed.
          if (warmOnly) {
            warmed = true;
            continue;
          }
          this.queuePreparation();
          return;
        }
        if (
          !warmOnly &&
          step <= domLookahead &&
          row?.retainDom &&
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
        if (warmOnly) {
          this.queuePreparation(!warmed);
        }
        return;
      }
      this.prepareStarted = performance.now();
      virtualizer.setOptions({
        ...virtualizer.options,
        rangeExtractor: (next) => this.extract(next),
      });
      this.invalidate();
    };
    if (
      !idleOnly &&
      this.virtualizer().isScrolling &&
      this.prewarmRow &&
      typeof requestIdleCallback === "function"
    ) {
      // Idle delivery can starve during scrolling. Warm Markdown in a separate
      // task; actual row mounting waits for idle or the visible range.
      const frame = requestAnimationFrame(() => {
        const task = setTimeout(() => prepare(performance.now() + 6, true, true), 0);
        this.cancelPreparation = () => clearTimeout(task);
      });
      this.cancelPreparation = () => cancelAnimationFrame(frame);
    } else if (typeof requestIdleCallback === "function") {
      this.preparationIsIdle = true;
      const idleRequest = requestIdleCallback(
        (idle) => prepare(performance.now() + (idle.timeRemaining() >= 6 ? 6 : 0), true),
        { timeout: 250 },
      );
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
  }
}
