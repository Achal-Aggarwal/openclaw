import { createMemo, Show } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  type GroupMessage,
  type NativeMessageGroupOptions,
  prepareGroupMessage,
} from "./chat-message-group-frame.ts";
import { FULL_MESSAGE_RETRY_REVISION_LIMIT } from "./chat-message-markdown-view.tsx";
import { GroupMessageReactions } from "./chat-message-reaction-chips-view.tsx";
import type { AssistantMessageDisclosure } from "./chat-message-text-view.tsx";
import { useChatToolReadiness } from "./chat-tool-family-boundary.tsx";

export function PreparedMessage(props: {
  group: MessageGroupData;
  item: GroupMessage;
  index: number;
  options: NativeMessageGroupOptions & Pick<GroupedMessageOptions, "replyLine">;
  prepared?: ReturnType<typeof prepareGroupMessage>;
  showReactions?: boolean;
}) {
  const toolsReady = useChatToolReadiness();
  const prepared = createMemo(() => {
    toolsReady();
    return props.prepared ?? prepareGroupMessage(props.group, props.item, props.options);
  });
  const isStreaming = () =>
    props.group.isStreaming && props.index === props.group.messages.length - 1;
  const options = createMemo(() => {
    const actionDetails = prepared().actions;
    let assistantMessageDisclosure: AssistantMessageDisclosure | undefined;
    const fullMessage = actionDetails?.fullMessage;
    if (
      fullMessage &&
      props.options.loadFullAssistantMessage &&
      props.options.onToggleAssistantMessageExpanded
    ) {
      const { messageId, state: expansion } = fullMessage;
      const retriesExhausted =
        expansion?.status === "error" && expansion.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT;
      assistantMessageDisclosure = {
        expanded: expansion?.status === "loaded",
        ...(expansion?.status === "loaded"
          ? { markdown: actionDetails?.markdown, message: expansion.message }
          : {}),
        ...(retriesExhausted
          ? {
              onRetryFullMessage: () => props.options.onToggleAssistantMessageExpanded?.(messageId),
            }
          : {}),
      };
    }
    const entryId = persistedMessageEntryId(props.item.message) ?? undefined;
    const openFile = props.options.onOpenWorkspaceFile;
    return {
      ...props.options,
      firstBubbleKey:
        props.options.firstBubbleKey !== undefined
          ? props.options.firstBubbleKey
          : (props.group.messages.find((message) => message.hasVisibleContent)?.key ?? null),
      isStreaming: isStreaming(),
      entryId,
      // Tool-row file links carry their message like rendered markdown links, so earlier
      // messages keep reading their original source; sender-owned links stay session-scoped.
      ...(entryId && openFile && !props.group.senderSession?.sessionKey
        ? {
            onOpenWorkspaceFile: (target: { path: string; line?: number | null }) => {
              const owned = { ...target, messageEntryId: entryId };
              openFile(owned);
            },
          }
        : {}),
      duplicateCount: props.item.duplicateCount ?? 1,
      showToolCalls: props.options.showToolCalls ?? true,
      assistantMessageDisclosure,
      messageActions: actionDetails,
    };
  });
  return (
    <>
      <GroupedMessage
        preparation={prepared().source}
        messageKey={props.item.key}
        options={options()}
        onOpenSidebar={props.options.onOpenSidebar}
      />
      <Show when={props.showReactions !== false}>
        <GroupMessageReactions
          group={props.group}
          actionDetails={prepared().actions}
          isStreaming={isStreaming()}
          options={props.options}
        />
      </Show>
    </>
  );
}
