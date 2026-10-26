import { createPooledObserver, listen } from "./listener.ts";

/** Capture descendant scrollers too; native view coordinates are viewport-relative. */
export const observeDocumentScroll = createPooledObserver((document: Document, notify) =>
  listen(document, "scroll", notify, true),
);
