import { createPooledObserver, listen } from "./listener.ts";

/** Share native resize delivery without changing callers' synchronous layout policy. */
export const observeWindowResize = createPooledObserver((view: Window, notify) =>
  listen(view, "resize", notify),
);
