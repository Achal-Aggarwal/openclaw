import { lazy } from "solid-js";
import "../../../styles/chat/skill-learned-notice.css";
import { loadChatToolPresentation } from "../../../lib/chat/tool-family.ts";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import { ChatNotice } from "./chat-notice-view.tsx";
import { RealtimeTalkConversation } from "./chat-realtime-controls.tsx";
import { TranscriptWorkPreviews } from "./chat-transcript-content.tsx";
import {
  AgentRunFrame,
  StreamGroup,
  TurnRecapRow,
  UnplacedSubagentWait,
} from "./chat-transcript-row-entries.ts";

export const nativeRows = {
  "system-events": lazy(() => import("./chat-system-events.tsx"), { export: "ChatSystemEvents" }),
  group: MessageGroup,
  activity: ActivityGroup,
  stream: StreamGroup,
  work: lazy(() => loadChatToolPresentation(), { export: "WorkGroupSummary" }),
  frame: AgentRunFrame,
  wait: UnplacedSubagentWait,
  divider: lazy(() => import("./chat-divider.tsx"), { export: "ChatDivider" }),
  notice: ChatNotice,
  "work-previews": TranscriptWorkPreviews,
  realtime: RealtimeTalkConversation,
  recap: TurnRecapRow,
  typing: lazy(() => import("./chat-typing-indicator.tsx"), { export: "ChatTypingIndicator" }),
};

export type NativeTranscriptView = {
  [Kind in keyof typeof nativeRows]: { kind: Kind } & Parameters<(typeof nativeRows)[Kind]>[0];
}[keyof typeof nativeRows];
