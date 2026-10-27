import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { createScrollPosition } from "../lib/reactive/scroll-state.ts";
import type { PickerOption } from "./select-picker-types.ts";

export type PickerWindowRow<Option> = {
  option: Option;
  index: number;
  count: number;
  start: number;
  size: number;
};

/** Mounted only for an open, caller-sized large picker. The menu owns selection;
 * virtual-core owns geometry, and the existing scroll primitive owns reveal. */
export default function PickerWindow<Option extends PickerOption>(props: {
  options: readonly Option[];
  active: string | null;
  viewport: () => HTMLDivElement;
  target: () => HTMLDivElement | undefined;
  pointerHighlight: () => boolean;
  renderRow: (
    row: () => PickerWindowRow<Option>,
    measure: (element: HTMLDivElement | null) => void,
  ) => JSX.Element;
}) {
  let current: readonly Option[] = [];
  const [window, setWindow] = createSignal<{
    source: readonly Option[];
    rows: PickerWindowRow<Option>[];
    height: number;
  }>({ source: [], rows: [], height: 0 });
  const publish = () =>
    setWindow({
      source: current,
      rows: virtualizer.getVirtualItems().map((item) => ({
        option: current[item.index]!,
        index: item.index,
        count: current.length,
        start: item.start,
        size: item.size,
      })),
      height: virtualizer.getTotalSize(),
    });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: props.viewport,
    estimateSize: () => 32,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
    measureElement: (element, entry, instance) => {
      if (entry) {
        return measureElement(element, entry, instance);
      }
      // Keep the estimate until the batched observer supplies actual heights.
      const index = instance.indexFromElement(element);
      return (
        instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
        instance.options.estimateSize(index)
      );
    },
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mount } = virtualizer;
    return mount();
  });
  createLayoutMeasurement(
    () => ({ rows: props.options, active: props.active }),
    (next) => {
      if (!next) {
        return;
      }
      current = next.rows;
      const activeIndex = current.findIndex((option) => option.value === next.active);
      virtualizer.setOptions({
        ...virtualizer.options,
        count: current.length,
        getItemKey: (index) => current[index]!.value,
        rangeExtractor: (range) =>
          [
            ...new Set([
              ...defaultRangeExtractor(range),
              ...(activeIndex < 0 ? [] : [activeIndex]),
            ]),
          ].toSorted((a, b) => a - b),
      });
      const { _willUpdate: update } = virtualizer;
      update();
      publish();
    },
    { targets: () => [props.viewport()], changeTiming: "sync" },
  );
  // The first spacer supplies a measurable viewport before the library has a range.
  const height = () =>
    window().source === props.options ? window().height : props.options.length * 32;
  const rows = () => (window().source === props.options ? window().rows : []);
  const activeRow = createMemo(() => rows().find((row) => row.option.value === props.active), {
    equals: (before, after) =>
      before?.option.value === after?.option.value &&
      before?.start === after?.start &&
      before?.size === after?.size,
  });
  createScrollPosition(
    () => ({
      reveal: activeRow()
        ? {
            // Observer measurements can move a row after its first reveal.
            identity: [props.options, props.active, activeRow()?.start, activeRow()?.size],
            target: () => (props.pointerHighlight() ? undefined : props.target()),
          }
        : undefined,
    }),
    { region: props.viewport, revealTiming: "animation-frame" },
  );
  return (
    <div class="picker-select__window" style={{ height: `${height()}px` }}>
      <For each={rows()} keyed={(row) => row.option.value}>
        {(row) => props.renderRow(row, virtualizer.measureElement)}
      </For>
    </div>
  );
}
