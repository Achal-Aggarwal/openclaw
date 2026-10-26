import { lazy } from "solid-js";

export const ActivityGroupEntries = lazy(
  () =>
    import("../chat-tool-presentation.runtime.ts").then(({ ActivityGroupEntries }) => ({
      ActivityGroupEntries,
    })),
  { export: "ActivityGroupEntries" },
);
