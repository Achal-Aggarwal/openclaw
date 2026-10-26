import { lazy } from "solid-js";

export const ActivityGroupEntries = lazy(() => import("./chat-message-group-rich.tsx"), {
  export: "ActivityGroupEntries",
});
