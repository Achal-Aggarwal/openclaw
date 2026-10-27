import { lazy, lazyModule } from "solid-js";

const activity = lazyModule(() => import("./chat-message-activity-view.tsx"));
const work = lazyModule(() => import("./chat-work-group-summary.tsx"));
const recap = lazyModule(() => import("./chat-turn-recap-view.tsx"));
const notice = lazyModule(() => import("./chat-notice-view.tsx"));
const realtime = lazyModule(() => import("./chat-realtime-controls.tsx"));
const forwarded = lazyModule(() => import("./chat-forwarded-attribution.tsx"));
const sessionActivity = lazyModule(() => import("./chat-session-activity.solid.tsx"));
const asyncQuestions = lazyModule(() => import("./chat-async-question-summary.tsx"));
const workspaceConflict = lazyModule(() => import("./chat-workspace-conflict.tsx"));

// Admission preloads each required factory before the retained row root sees
// its snapshot. Shared callers outside the transcript retain native lazy reads.
export const ActivityGroupContent = lazy(activity, { export: "ActivityGroupContent" });
export const WorkGroupSummary = lazy(work, { export: "WorkGroupSummary" });
export const TurnRecapRow = lazy(recap, { export: "TurnRecapRow" });
export const ChatNotice = lazy(notice, { export: "ChatNotice" });
export const RealtimeTalkConversation = lazy(realtime, { export: "RealtimeTalkConversation" });
export const ForwardedAttribution = lazy(forwarded, { export: "ForwardedAttribution" });
export const ChatSessionActivity = lazy(sessionActivity, { export: "ChatSessionActivity" });
export const AsyncQuestionSummary = lazy(asyncQuestions, { export: "AsyncQuestionSummary" });
export const WorkspaceConflictTranscriptMessage = lazy(workspaceConflict, {
  export: "WorkspaceConflictTranscriptMessage",
});

export const TranscriptSpecialization = {
  activity: 1,
  work: 2,
  recap: 4,
  notice: 8,
  realtime: 16,
  forwarded: 32,
  sessionActivity: 64,
  asyncQuestions: 128,
  workspaceConflict: 256,
} as const;

const modules = [
  activity,
  work,
  recap,
  notice,
  realtime,
  forwarded,
  sessionActivity,
  asyncQuestions,
  workspaceConflict,
];
const preload = [
  () => ActivityGroupContent.preload(),
  () => WorkGroupSummary.preload(),
  () => TurnRecapRow.preload(),
  () => ChatNotice.preload(),
  () => RealtimeTalkConversation.preload(),
  () => ForwardedAttribution.preload(),
  () => ChatSessionActivity.preload(),
  () => AsyncQuestionSummary.preload(),
  () => WorkspaceConflictTranscriptMessage.preload(),
];

export function prepareTranscriptSpecializations(mask: number) {
  if (!mask) {
    return undefined;
  }
  const indexes = modules.flatMap((_, index) => (mask & (1 << index) ? [index] : []));
  return {
    key: mask,
    ready: () => indexes.every((index) => modules[index]!.peek() !== undefined),
    load: () => Promise.all(indexes.map((index) => preload[index]!())).then(() => {}),
  };
}
