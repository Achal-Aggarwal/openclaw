import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isAgentActivityItem } from "../protocol-validators.generated/activity.js";
import { readChatToolFamily } from "./tool-family.ts";

export function readPreparedActivity(message: unknown): AgentActivityItem[] {
  const activity = asOptionalRecord(message)?.activity;
  return Array.isArray(activity) ? activity.filter(isAgentActivityItem) : [];
}

export function hasVisiblePreparedActivity(message: unknown): boolean {
  return readPreparedActivity(message).some(
    (activity) => !activity.hideFromChannelProgress && !activity.suppressChannelProgress,
  );
}

export type ToolGroupOptions = {
  /** Calls of launches that opened a session in its own right, not a subagent. */
  ownSessionLaunches?: ReadonlySet<string>;
};

export function describeToolGroup(
  items: readonly AgentActivityItem[],
  options: ToolGroupOptions = {},
): ReturnType<typeof import("./tool-call-grouping.runtime.ts").describeToolGroup> {
  return readChatToolFamily().describeToolGroup(items, options);
}

export function summarizeToolGroup(
  items: readonly AgentActivityItem[],
  options: ToolGroupOptions & { includeInlineOutcomes?: boolean } = {},
): string {
  return readChatToolFamily().summarizeToolGroup(items, options);
}
