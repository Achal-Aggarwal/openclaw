import { createMemo, createSignal, For, lazy, onSettled, Show } from "solid-js";
import { PersonName } from "../../../components/person-activity-link-solid.tsx";
import { personActivityLink } from "../../../components/person-activity-link.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { createMediaQuerySource } from "../../../lib/reactive/platform.ts";
import { ChatAvatar, ForwardedAvatar } from "../chat-avatar.ts";
import { hasForwardedSource, isSessionActivityGroup } from "../chat-turn-boundary.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { BrowserTabPreviews } from "./chat-browser-tab-previews.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { RewindButton } from "./chat-message-confirmation-view.tsx";
import {
  type GroupMessage,
  type MessageGroupFrame,
  type NativeMessageGroupOptions,
  isActivityMessageGroup,
  prepareMessageGroupFrame,
  resolveFileLinkOwnerOptions,
} from "./chat-message-group-frame.ts";
import {
  hasMessageActionButtons,
  MessageActions,
  ReplyButton,
} from "./chat-message-markdown-view.tsx";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";
import { messageReactionOptions } from "./chat-message-reaction-model.ts";
import { ChatSendStatus } from "./chat-message-send-status-view.tsx";
import { MessageMeta } from "./chat-message-timestamp-view.tsx";
import { PreparedMessage } from "./chat-prepared-message.tsx";
import { NO_REPLY_LINE, resolveMessageReplyLine } from "./chat-reply-attribution.ts";
import { ReplyLineView, ReplyLineConnector } from "./chat-reply-attribution.tsx";
import type { ReplyConnectorElements } from "./chat-reply-connector.tsx";
import { selectBrowserTabPreviews } from "./chat-tool-cards.ts";
import { ChatToolFamilyBoundary, useChatToolReadiness } from "./chat-tool-family-boundary.tsx";
import { TurnRecapRow } from "./chat-turn-recap-view.tsx";

const StreamGroupParts = lazy(() => import("./chat-message-stream-view.tsx"), {
  export: "StreamGroupParts",
});

const ForwardedAttribution = lazy(() => import("./chat-forwarded-attribution.tsx"), {
  export: "ForwardedAttribution",
});

const ActivityGroupEntries = lazy(() => import("./chat-message-group-rich.tsx"), {
  export: "ActivityGroupEntries",
});

export function ActivityGroup(props: {
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  return (
    <ChatToolFamilyBoundary
      sources={props.groups.map((group) => group.messages.map((item) => item.message))}
    >
      <ChatLazyBoundary>
        <ActivityGroupEntries {...props} />
      </ChatLazyBoundary>
    </ChatToolFamilyBoundary>
  );
}

export function MessageGroupContent(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  return (
    <ChatToolFamilyBoundary sources={[props.group.messages.map((item) => item.message)]}>
      <PreparedMessageGroupContent {...props} />
    </ChatToolFamilyBoundary>
  );
}

function PreparedMessageGroupContent(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const toolsReady = useChatToolReadiness();
  const options = createMemo(() => {
    toolsReady();
    return resolveFileLinkOwnerOptions(props.group, props.options);
  });
  return (
    <Show
      when={!isActivityMessageGroup(props.group, options().bubbleMode)}
      fallback={
        <ActivityGroup groups={[props.group]} options={options()} presentation="continuation" />
      }
    >
      <For each={props.group.messages} keyed={(item) => item.key}>
        {(item, index) => (
          <PreparedMessage
            group={props.group}
            item={item()}
            index={index()}
            options={{ ...options(), isForwarded: hasForwardedSource(props.group) }}
          />
        )}
      </For>
      {options().showToolCalls === false ? undefined : (
        <BrowserTabPreviews
          previews={selectBrowserTabPreviews([props.group], options())}
          mediaReadAllowed={options().mediaReadAllowed}
        />
      )}
    </Show>
  );
}

const SessionActivityGroup = lazy(() => import("./chat-message-group-rich.tsx"), {
  export: "SessionActivityGroup",
});

export type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";

function MessageActionsRow(props: {
  messageKey?: string;
  details: MessageActionDetails | null | undefined;
  options: NativeMessageGroupOptions;
  class?: string;
}) {
  let owner: HTMLDivElement | undefined;
  return (
    <div
      ref={(element) => {
        owner = element;
      }}
      class={props.class ?? "chat-group-footer-actions"}
      data-message-actions-for={props.messageKey}
    >
      <MessageActions
        details={props.details}
        options={props.options}
        actionOwner={() => owner}
        messageKey={props.messageKey}
      />
    </div>
  );
}

function GroupAvatar(props: {
  frame: MessageGroupFrame;
  elementRef?: (element: HTMLElement) => void;
}) {
  const frame = () => props.frame;
  const options = () => frame().options;
  return (
    <Show when={frame().hasAvatar}>
      <Show
        when={frame().isForwarded}
        fallback={
          <ChatAvatar
            elementRef={props.elementRef}
            mediaReadAllowed={options().mediaReadAllowed}
            role={frame().group.role}
            assistant={{
              agentId: options().agentId,
              name: frame().assistantName,
              avatar: options().assistantAvatar ?? null,
              textAvatar: options().assistantTextAvatar,
            }}
            user={
              frame().isOwnGroup
                ? { name: options().userName ?? null, avatar: options().userAvatar ?? null }
                : undefined
            }
            sender={frame().group.sender}
            channelAvatar={options().channelAvatar}
          />
        }
      >
        <ForwardedAvatar
          agentId={frame().group.senderSession?.agentId}
          options={options()}
          elementRef={props.elementRef}
        />
      </Show>
    </Show>
  );
}

function SenderIdentity(props: { frame: MessageGroupFrame }) {
  const frame = () => props.frame;
  const activityLink = createMemo(() => {
    const current = frame();
    const identity = current.group.sender?.identity;
    return current.isPeerGroup && identity?.type === "profile"
      ? personActivityLink(identity.id, current.options.personActivity, current.who)
      : null;
  });
  return (
    <>
      <Show when={frame().showSenderName}>
        <PersonName label={frame().who} link={activityLink()} class="chat-sender-name" />
      </Show>
      <Show when={frame().visibleSources?.length}>
        <span class="chat-message-source">
          {messageClientSourcesLabel(frame().visibleSources!)}
        </span>
      </Show>
    </>
  );
}

function UserFooterActions(props: { frame: MessageGroupFrame }) {
  let owner: HTMLDivElement | undefined;
  const frame = () => props.frame;
  const options = () => frame().options;
  return (
    <Show when={frame().hasUserFooterActions}>
      <div
        class="chat-group-footer-actions"
        ref={(element) => {
          owner = element;
        }}
        data-message-actions-for={frame().footerActionMessageKey}
      >
        <Show when={Boolean(frame().footerActionDetails?.replyTarget && options().onReply)}>
          <ReplyButton
            target={frame().footerActionDetails!.replyTarget!}
            onReply={options().onReply!}
          />
        </Show>
        <Show when={options().onRewind && !options().rewindDisabled}>
          <RewindButton onRewind={options().onRewind!} />
        </Show>
        <MessageActions
          details={frame().footerActionDetails}
          options={messageReactionOptions(frame().group, options())}
          actionOwner={() => owner}
          messageKey={frame().footerActionMessageKey}
        />
      </div>
    </Show>
  );
}

function FramedMessage(props: {
  frame: MessageGroupFrame;
  item: GroupMessage;
  index: number;
  mobile: boolean;
}) {
  const replyElements: ReplyConnectorElements = {};
  const frame = () => props.frame;
  const prepared = () => frame().preparedMessages[props.index]!;
  const line = createMemo(() =>
    frame().normalizedRole === "assistant"
      ? NO_REPLY_LINE
      : resolveMessageReplyLine(
          prepared().source.normalizedMessage,
          frame().options.resolveReplyPreview,
          frame().options.userId,
          frame().isPeerGroup || frame().group.replyShared,
        ),
  );
  const peerHoldsRow = () => frame().isPeerGroup && line().state !== "hidden";
  const avatar = () => <GroupAvatar frame={props.frame} />;
  const options = createMemo(() => ({
    ...frame().options,
    isForwarded: frame().forwardedSource,
    replyLine: frame().isPeerGroup ? undefined : line(),
    avatar:
      !peerHoldsRow() &&
      frame().inlineUserAvatar &&
      (frame().isPeerGroup || props.index === frame().lastMessageIndex) &&
      frame().hasAvatar
        ? avatar
        : undefined,
  }));
  const showActions = () =>
    prepared().ownsActions &&
    hasMessageActionButtons(prepared().actions, frame().options) &&
    props.index < frame().lastMessageIndex &&
    !frame().isTurnBlock;
  return (
    <>
      {/* Showing a previously absent peer reply changes this local message's structural wrapper. */}
      <Show
        when={peerHoldsRow()}
        fallback={
          <>
            {frame().isPeerGroup ? (
              <ReplyLineView line={line()} actions={frame().options} />
            ) : undefined}
            <PreparedMessage
              group={frame().group}
              item={props.item}
              index={props.index}
              options={options()}
              prepared={prepared()}
            />
          </>
        }
      >
        <div ref={(element) => (replyElements.group = element)} class="chat-message--reply">
          <ReplyLineView line={line()} actions={frame().options} elements={replyElements} />
          <PreparedMessage
            group={frame().group}
            item={props.item}
            index={props.index}
            options={options()}
            prepared={prepared()}
          />
          <GroupAvatar
            frame={props.frame}
            elementRef={(element) => (replyElements.avatar = element)}
          />
          <ReplyLineConnector line={line()} avatar={frame().hasAvatar} elements={replyElements} />
        </div>
      </Show>
      <Show when={showActions()}>
        <Show
          when={props.mobile}
          fallback={
            <MessageActionsRow
              messageKey={props.item.key}
              details={prepared().actions}
              options={frame().options}
              class="chat-message-actions-row"
            />
          }
        >
          <div class="chat-group-footer chat-message-footer">
            <div class="chat-group-footer__meta">
              <SenderIdentity frame={props.frame} />
              <MessageMeta timestamp={prepared().source.normalizedMessage.timestamp} meta={null} />
            </div>
            <MessageActionsRow
              messageKey={props.item.key}
              details={prepared().actions}
              options={frame().options}
            />
          </div>
        </Show>
      </Show>
    </>
  );
}

function FramedMessageGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const toolsReady = useChatToolReadiness();
  const replyElements: ReplyConnectorElements = {};
  const frame = createMemo(() => {
    toolsReady();
    return prepareMessageGroupFrame(props.group, props.options);
  });
  const options = () => frame().options;
  const media = createMediaQuerySource(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  );
  const [mobile, setMobile] = createSignal(media.read());
  onSettled(() => media.subscribe(setMobile));
  return (
    <div
      ref={(element) => (replyElements.group = element)}
      class={frame().className}
      style={frame().style}
      data-chat-row-key={props.group.key}
      data-chat-streaming={props.group.isStreaming ? "true" : undefined}
      data-file-session-key={frame().sessionKey}
    >
      <Show when={!frame().inlineUserAvatar}>
        <GroupAvatar frame={frame()} elementRef={(element) => (replyElements.avatar = element)} />
      </Show>
      <div ref={(element) => (replyElements.messages = element)} class="chat-group-messages">
        <Show when={frame().forwardedSource}>
          <ChatLazyBoundary>
            <ForwardedAttribution group={props.group} options={options()} />
          </ChatLazyBoundary>
        </Show>
        <ReplyLineView line={frame().replyLine} actions={options()} elements={replyElements} />
        <Show
          when={options().frameContent !== undefined}
          fallback={
            <For each={props.group.messages} keyed={(item) => item.key}>
              {(item, index) => (
                <FramedMessage frame={frame()} item={item()} index={index()} mobile={mobile()} />
              )}
            </For>
          }
        >
          {options().frameContent}
        </Show>
        {frame().ownsRunFrame || options().showToolCalls === false ? undefined : (
          <BrowserTabPreviews
            previews={selectBrowserTabPreviews([props.group], options())}
            mediaReadAllowed={options().mediaReadAllowed}
          />
        )}
        <Show
          when={Boolean(options().activeContinuation)}
          fallback={
            options().turnRecap ? (
              <TurnRecapRow
                recap={options().turnRecap!}
                presentation="continuation"
                hideDuration={options().hideTurnRecapDuration}
              />
            ) : undefined
          }
        >
          <ChatLazyBoundary>
            <StreamGroupParts
              parts={options().activeContinuation!.parts}
              options={options().activeContinuation!.options}
              presentation="continuation"
            />
          </ChatLazyBoundary>
        </Show>
      </div>
      <Show when={!frame().isTurnBlock}>
        <Show
          when={!props.group.isStreaming && !options().activeContinuation}
          fallback={<div class="chat-group-footer" aria-hidden="true" />}
        >
          <div
            class={[
              "chat-group-footer",
              {
                "chat-group-footer--persistent-identity":
                  frame().normalizedRole === "user" &&
                  Boolean(
                    frame().visibleSources?.length ||
                    frame().isPeerGroup ||
                    (frame().showSenderName && frame().avatarPlacement !== "footer"),
                  ),
                "chat-group-footer--send-status": Boolean(frame().sendStatus),
              },
            ]}
          >
            <Show when={!frame().isPeerGroup}>
              <UserFooterActions frame={frame()} />
            </Show>
            <div class="chat-group-footer__meta">
              {frame().normalizedRole === "user" &&
              frame().showAvatar &&
              frame().avatarPlacement === "footer" ? (
                <Show
                  when={options().mediaReadAllowed !== false}
                  fallback={<span class="chat-author-avatar" aria-hidden="true" />}
                >
                  <ChatAuthorAvatar
                    sender={props.group.sender}
                    channelAvatar={options().channelAvatar}
                  />
                </Show>
              ) : undefined}
              <SenderIdentity frame={frame()} />
              {/* Keep delivery status and timestamp in one slot to avoid wrapping them together. */}
              <Show
                when={frame().sendStatus}
                fallback={<MessageMeta timestamp={props.group.timestamp} meta={frame().meta} />}
              >
                <ChatSendStatus status={frame().sendStatus} actions={options()} />
              </Show>
            </div>
            <Show
              when={frame().isPeerGroup}
              fallback={
                <Show when={frame().normalizedRole !== "user" && frame().footerActionDetails}>
                  <MessageActionsRow
                    messageKey={frame().footerActionMessageKey}
                    details={frame().footerActionDetails}
                    options={options()}
                  />
                </Show>
              }
            >
              <UserFooterActions frame={frame()} />
            </Show>
          </div>
        </Show>
      </Show>
      <ReplyLineConnector
        line={frame().replyLine}
        avatar={frame().hasAvatar}
        elements={replyElements}
      />
    </div>
  );
}

export function MessageGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  return (
    <ChatToolFamilyBoundary sources={[props.group.messages.map((item) => item.message)]}>
      <PreparedMessageGroup {...props} />
    </ChatToolFamilyBoundary>
  );
}

function PreparedMessageGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const toolsReady = useChatToolReadiness();
  const options = createMemo(() => {
    toolsReady();
    return resolveFileLinkOwnerOptions(props.group, props.options);
  });
  return (
    <Show
      when={!isSessionActivityGroup(props.group)}
      fallback={
        <ChatLazyBoundary>
          <SessionActivityGroup group={props.group} options={props.options} />
        </ChatLazyBoundary>
      }
    >
      <Show
        when={
          normalizeRoleForGrouping(props.group.role) !== "tool" || options().showToolCalls !== false
        }
      >
        <Show
          when={!isActivityMessageGroup(props.group, options().bubbleMode)}
          fallback={
            <ActivityGroup groups={[props.group]} options={options()} presentation="standalone" />
          }
        >
          <FramedMessageGroup group={props.group} options={props.options} />
        </Show>
      </Show>
    </Show>
  );
}
