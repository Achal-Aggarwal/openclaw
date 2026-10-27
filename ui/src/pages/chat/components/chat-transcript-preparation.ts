import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { resolveSourceMessageId } from "../chat-message-recovery.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { hasForwardedSource, isSessionActivityGroup } from "../chat-turn-boundary.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { readAsyncQuestions } from "./chat-async-question-content.ts";
import {
  isActivityMessageGroup,
  type NativeMessageGroupOptions,
} from "./chat-message-group-frame.ts";
import type { TranscriptPreparationRequest, TranscriptRow } from "./chat-transcript-layout.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import {
  prepareTranscriptSpecializations,
  TranscriptSpecialization as Kind,
} from "./chat-transcript-specialized.ts";

type MessageContentOptions = Pick<
  NativeMessageGroupOptions,
  "bubbleMode" | "asyncQuestions" | "getAssistantMessageExpansion"
>;
type GroupOptions = (group: MessageGroup) => MessageContentOptions;

/** Inspect prepared row kinds; never prepare Markdown or normalize source messages here. */
export function prepareTranscriptRows(
  rows: readonly TranscriptRow<SystemEventRenderItem>[],
  options: {
    bubbleMode?: boolean;
    recap?: boolean;
    asyncQuestions?: boolean;
    getAssistantMessageExpansion?: MessageContentOptions["getAssistantMessageExpansion"];
  } = {},
): TranscriptPreparationRequest | undefined {
  let mask = options.recap ? Kind.recap : 0;
  const messageContent = (message: unknown, questions: boolean) => {
    if (questions && readAsyncQuestions(message)) mask |= Kind.asyncQuestions;
    if (workspaceResultConflictFromTranscript(message)) mask |= Kind.workspaceConflict;
  };
  const groupContent = (value: MessageGroup, renderOptions?: MessageContentOptions) => {
    // A prewarmed snapshot has no live action context yet, so valid recorded
    // questions are a conservative upper bound until the pane supplies it.
    const questions = renderOptions
      ? Boolean(renderOptions.asyncQuestions?.submit)
      : options.asyncQuestions !== false;
    const getExpansion =
      renderOptions?.getAssistantMessageExpansion ?? options.getAssistantMessageExpansion;
    for (const { message } of value.messages) {
      messageContent(message, questions);
      const id = getExpansion && resolveSourceMessageId(message);
      const expansion = id ? getExpansion?.(id) : undefined;
      // The rendering owner decides whether recovery replaces this message.
      // Inspect its resident candidate too, without copying that selection policy.
      if (expansion?.status === "loaded" && expansion.message !== undefined) {
        messageContent(expansion.message, questions);
      }
    }
  };
  const group = (value: MessageGroup, renderOptions?: MessageContentOptions) => {
    groupContent(value, renderOptions);
    const bubbleMode = renderOptions?.bubbleMode ?? options.bubbleMode;
    if (isSessionActivityGroup(value)) mask |= Kind.sessionActivity | Kind.forwarded;
    else if (isActivityMessageGroup(value, bubbleMode)) mask |= Kind.activity;
    else if (hasForwardedSource(value)) mask |= Kind.forwarded;
  };
  const item = (value: SystemEventRenderItem, groupOptions?: GroupOptions): void => {
    switch (value.kind) {
      case "agent-run-frame":
        for (const part of value.parts) item(part, groupOptions);
        break;
      case "group":
        group(value, groupOptions?.(value));
        break;
      case "activity-run":
        if (value.groups.length > 1) {
          mask |= Kind.activity;
          for (const valueGroup of value.groups)
            groupContent(valueGroup, groupOptions?.(valueGroup));
        } else if (value.groups[0]) group(value.groups[0], groupOptions?.(value.groups[0]));
        break;
      case "work-group":
        mask |= Kind.work;
        // Expanded work uses the same message-group presentation rules.
        for (const valueGroup of value.groups) group(valueGroup, groupOptions?.(valueGroup));
        break;
      case "notice":
        mask |= Kind.notice;
        break;
    }
  };
  const native = (value: NativeTranscriptView): void => {
    switch (value.kind) {
      case "group":
        group(value.group, value.options);
        if (value.options.turnRecap) mask |= Kind.recap;
        break;
      case "activity":
        mask |= Kind.activity;
        for (const valueGroup of value.groups) groupContent(valueGroup, value.options);
        break;
      case "work":
        mask |= Kind.work;
        break;
      case "frame":
        item(value.frame, value.options.renderGroupOptions);
        if (value.options.turnRecap) mask |= Kind.recap;
        break;
      case "notice":
        mask |= Kind.notice;
        break;
      case "recap":
        mask |= Kind.recap;
        break;
      case "realtime":
        mask |= Kind.realtime;
        break;
    }
  };
  for (const row of rows) {
    if (row.kind === "item") item(row.item);
    else if (row.content instanceof GuardedTranscriptItem && row.content.native)
      native(row.content.native);
  }
  return prepareTranscriptSpecializations(mask);
}
