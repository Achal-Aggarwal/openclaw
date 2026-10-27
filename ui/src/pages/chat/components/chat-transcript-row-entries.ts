import { lazy } from "solid-js";

export const NativeTranscriptRowDemand = { frame: 1, stream: 2, recap: 4 } as const;

export const AgentRunFrame = lazy(() => import("./chat-agent-run-frame.tsx"), {
  export: "AgentRunFrame",
});
export const StreamGroup = lazy(() => import("./chat-message-stream-view.tsx"), {
  export: "StreamGroup",
});
export const StreamGroupParts = lazy(() => import("./chat-message-stream-view.tsx"), {
  export: "StreamGroupParts",
});
export const UnplacedSubagentWait = lazy(() => import("./chat-message-stream-view.tsx"), {
  export: "UnplacedSubagentWait",
});
export const TurnRecapRow = lazy(() => import("./chat-turn-recap-view.tsx"), {
  export: "TurnRecapRow",
});

/** Prepare only the families present in the already-normalized transcript rows. */
export function prepareNativeTranscriptRows(demand: number): true | Promise<true> {
  const pending: Promise<unknown>[] = [];
  if (demand & NativeTranscriptRowDemand.frame) {
    pending.push(AgentRunFrame.preload());
  }
  if (demand & NativeTranscriptRowDemand.stream) {
    pending.push(StreamGroup.preload(), StreamGroupParts.preload(), UnplacedSubagentWait.preload());
  }
  if (demand & NativeTranscriptRowDemand.recap) {
    pending.push(TurnRecapRow.preload());
  }
  return pending.length ? Promise.all(pending).then(() => true as const) : true;
}
