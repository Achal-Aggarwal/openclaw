import { Show } from "solid-js";
import { createPositionRail, type PositionRailParams } from "./chat-position-rail-controller.ts";
import { ChatPositionRailView } from "./chat-position-rail-view.tsx";

export function ChatPositionRail(props: PositionRailParams) {
  const rail = createPositionRail(props);
  return (
    <Show when={rail.view()}>
      {(current) => (
        <ChatPositionRailView
          {...current()}
          bindMarker={rail.bindings.bindMarker}
          bindScroller={rail.bindings.bindScroller}
          bindPreview={rail.bindings.bindPreview}
          stopScrollInput={rail.bindings.stopScrollInput}
        />
      )}
    </Show>
  );
}
