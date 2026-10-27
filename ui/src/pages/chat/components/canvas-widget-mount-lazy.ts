import { lazy } from "solid-js";

export const CanvasWidgetMount = lazy(() => import("./canvas-widget-mount.tsx"), {
  export: "CanvasWidgetMount",
});
