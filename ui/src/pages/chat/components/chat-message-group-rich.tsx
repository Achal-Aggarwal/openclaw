import { createMemo, For, lazy } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import {
  type NativeMessageGroupOptions,
  prepareGroupMessage,
  resolveFileLinkOwnerOptions,
} from "./chat-message-group-frame.ts";
import { MessageActions } from "./chat-message-markdown-view.tsx";
import { PreparedMessage } from "./chat-prepared-message.tsx";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { ChatSessionActivity } from "./chat-session-activity.solid.tsx";
import { useChatToolReadiness } from "./chat-tool-family-boundary.tsx";

const ActivityGroupContent = lazy(() => import("./chat-message-activity-view.tsx"), {
  export: "ActivityGroupContent",
});

export function ActivityGroupEntries(props: {
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  return (
    <ActivityGroupContent
      {...props}
      renderEntries={(overrides) => (
        <For each={props.groups} keyed={(group) => group.key}>
          {(group) => (
            <For each={group().messages} keyed={(item) => item.key}>
              {(item, index) => (
                <PreparedMessage
                  group={group()}
                  item={item()}
                  index={index()}
                  options={{ ...props.options, toolCardOverrides: overrides() }}
                />
              )}
            </For>
          )}
        </For>
      )}
    />
  );
}

export function SessionActivityGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const toolsReady = useChatToolReadiness();
  const options = createMemo(() => resolveFileLinkOwnerOptions(props.group, props.options));
  return (
    <ChatSessionActivity
      group={props.group}
      options={options()}
      renderEntry={(item, index) => {
        const prepared = createMemo(() => {
          toolsReady();
          return prepareGroupMessage(props.group, item(), options());
        });
        let actionOwner: HTMLDivElement | undefined;
        return {
          actionsRef: (element: HTMLDivElement) => {
            actionOwner = element;
          },
          content: (
            <PreparedMessage
              group={props.group}
              item={item()}
              index={index()}
              prepared={prepared()}
              options={{
                ...options(),
                isForwarded: true,
                onToggleUserMessageExpanded: undefined,
                replyLine: resolveGroupReplyLine(
                  { ...props.group, messages: [item()] },
                  options().resolveReplyPreview,
                ),
              }}
            />
          ),
          actions: (
            <MessageActions
              details={prepared().actions}
              options={options()}
              actionOwner={() => actionOwner}
              messageKey={item().key}
            />
          ),
        };
      }}
    />
  );
}
