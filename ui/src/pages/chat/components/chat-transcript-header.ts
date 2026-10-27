import type { Virtualizer } from "@tanstack/virtual-core";

/** Compensate a header change when unchanged row keys do not trigger a prepend anchor. */
export function reconcileTranscriptHeaderMargin(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  headerHeight: number,
  appliedHeaderHeight: number,
): number {
  if (headerHeight === appliedHeaderHeight) {
    return appliedHeaderHeight;
  }
  const delta = headerHeight - appliedHeaderHeight;
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin: virtualizer.options.scrollMargin + delta,
  });
  const offset = virtualizer.scrollOffset;
  const next = offset === null ? null : Math.max(0, offset + delta);
  if (next !== null && next !== offset) {
    virtualizer.scrollOffset = next;
    virtualizer.scrollToOffset(next);
  }
  return headerHeight;
}

/** Update row keys and their header margin in one virtualizer adjustment. */
export function setTranscriptRowKeys(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  keys: readonly string[],
  headerHeight: number,
  appliedHeaderHeight: number,
  rangeExtractor: Virtualizer<HTMLDivElement, HTMLElement>["options"]["rangeExtractor"],
): number {
  // Prepending rows and removing their header must share one edge-key re-anchor.
  virtualizer.setOptions({
    ...virtualizer.options,
    count: keys.length,
    getItemKey: (index) => keys[index]!,
    rangeExtractor,
    scrollMargin: virtualizer.options.scrollMargin + headerHeight - appliedHeaderHeight,
  });
  return headerHeight;
}
