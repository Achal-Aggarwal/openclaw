import { For } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { ActivityGroupContent } from "./chat-message-activity-view.tsx";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { PreparedMessage } from "./chat-prepared-message.tsx";

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
