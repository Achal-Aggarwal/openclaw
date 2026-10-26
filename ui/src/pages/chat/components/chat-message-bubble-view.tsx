import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  lazy,
  Match,
  Show,
  Switch,
  refresh,
  untrack,
  useContext,
} from "solid-js";
import { readMessageWorkContext } from "../../../../../src/chat/work-context.js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { prepareMarkdownJson } from "../../../lib/markdown-json.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { assistantMessageIsInterrupted } from "../chat-assistant-reply.ts";
import "../../../components/solid/person-reference.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { AssistantViews } from "./chat-message-assistant-views.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import {
  prepareGroupedMessage,
  type MessageContentProps as ContentProps,
} from "./chat-message-bubble-presentation.ts";
import {
  prepareChatMessageRender,
  type ChatMessageRenderPreparation,
} from "./chat-message-markdown-view.tsx";
import type { MarkdownMedia, PositionedMedia } from "./chat-message-media-markdown.ts";
import { prepareMarkdownMedia } from "./chat-message-media-markdown.ts";
import {
  schedulePairingQrExpiryRefresh,
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
} from "./chat-message-media.ts";
import { MessageJson, MessageMarkdown } from "./chat-message-text-view.tsx";
import { ReplyLineView } from "./chat-reply-attribution.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { ChatToolFamilyBoundary, useChatToolReadiness } from "./chat-tool-family-boundary.tsx";
import { TranscriptMessageElementsContext } from "./chat-transcript-message-elements.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const RichBubbleFrame = lazy(() => import("./chat-message-bubble-rich.tsx"), {
  export: "RichBubbleFrame",
});
const MessageReasoning = lazy(() => import("./chat-message-bubble-rich.tsx"), {
  export: "MessageReasoning",
});
const RichBubbleBefore = lazy(() => import("./chat-message-bubble-rich.tsx"), {
  export: "RichBubbleBefore",
});
const RichBubbleAfter = lazy(() => import("./chat-message-bubble-rich.tsx"), {
  export: "RichBubbleAfter",
});
const OrderedMessageMedia = lazy(() => import("./chat-message-bubble-rich.tsx"), {
  export: "OrderedMessageMedia",
});
const AsyncQuestionSummary = lazy(() => import("./chat-async-question-summary.tsx"), {
  export: "AsyncQuestionSummary",
});
const MessageWorkContext = lazy(() => import("./chat-message-context-view.tsx"), {
  export: "MessageWorkContext",
});
const WorkspaceConflictTranscriptMessage = lazy(() => import("./chat-workspace-conflict.tsx"), {
  export: "WorkspaceConflictTranscriptMessage",
});

type GroupedMessageProps = {
  preparation: ChatMessageRenderPreparation;
  messageKey: string;
  options: GroupedMessageOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
};

/** Message identity owns text/media DOM; option refreshes only publish new facts. */
export function GroupedMessage(props: GroupedMessageProps) {
  const message = () => {
    const disclosure = props.options.assistantMessageDisclosure;
    return disclosure?.expanded && disclosure.message
      ? disclosure.message
      : props.preparation.message;
  };
  return (
    <ChatToolFamilyBoundary sources={[[message()]]}>
      <PreparedGroupedMessage {...props} />
    </ChatToolFamilyBoundary>
  );
}

function PreparedGroupedMessage(props: GroupedMessageProps) {
  const toolsReady = useChatToolReadiness();
  const refreshMedia = () => void refresh(state);
  const preparation = createMemo(() => {
    const disclosure = props.options.assistantMessageDisclosure;
    return disclosure?.expanded && disclosure.message
      ? prepareChatMessageRender(disclosure.message)
      : props.preparation;
  });
  const json = createMemo(() => {
    const prepared = preparation();
    const markdown =
      normalizeRoleForGrouping(prepared.normalizedMessage.role) === "user"
        ? (props.options.messageActions?.markdown ?? prepared.displayMarkdown)
        : prepared.displayMarkdown;
    return props.options.isStreaming ? null : prepareMarkdownJson(markdown);
  });
  const state = createMemo(() => {
    toolsReady();
    return prepareGroupedMessage(
      preparation(),
      props.messageKey,
      props.options,
      props.onOpenSidebar,
      json(),
    );
  });
  const messageElements = useContext(TranscriptMessageElementsContext);
  // The keyed message owns this DOM registration through acknowledgement and option refreshes.
  const initialMessageKey = untrack(() => props.messageKey);
  // Expiring pairing QR attachments schedule a timer at their resource owner.
  createEffect(
    () => [props.options.mediaOwner, props.messageKey, state().nextPairingQrExpiresAt] as const,
    ([owner, key, expiresAt]) => {
      if (expiresAt === undefined) {
        return undefined;
      }
      observeChatMediaResourceSubscriber(owner, refreshMedia);
      schedulePairingQrExpiryRefresh(key, expiresAt, refreshMedia);
      return () => releaseChatMediaResourceOwner(refreshMedia);
    },
  );
  return (
    <Show
      when={state().workspaceConflict}
      fallback={
        <Show when={!state().empty}>
          {(_visible) => {
            const entryRef = messageElements?.forKey(initialMessageKey);
            const bindEntry = elementRef((element) => {
              entryRef?.(element);
              return () => entryRef?.(undefined);
            });
            return (
              <>
                <div
                  class={state().bubbleClasses}
                  ref={[bindEntry]}
                  data-message-id={props.messageKey}
                  data-file-session-key={props.options.fileLinkSessionKey}
                  data-entry-id={props.options.entryId || undefined}
                  data-message-text={state().actionText || undefined}
                  prop:messageActions={props.options.messageActions}
                >
                  <Show when={props.options.replyLine}>
                    <ReplyLineView line={props.options.replyLine!} actions={props.options} inline />
                  </Show>
                  <Show
                    when={
                      state().voiceTranscript ||
                      state().onlyToolCards ||
                      state().isStandaloneToolMessage
                    }
                    fallback={<BubbleContents {...props} state={state} />}
                  >
                    <ChatLazyBoundary>
                      <RichBubbleFrame
                        {...props}
                        state={state}
                        renderContents={() => <BubbleContents {...props} state={state} />}
                      />
                    </ChatLazyBoundary>
                  </Show>
                  <Show
                    when={
                      state().sourceRole === "assistant" &&
                      assistantMessageIsInterrupted(state().message)
                    }
                  >
                    <div
                      class="chat-tasks-status chat-turn-recap chat-turn-recap--continuation"
                      role="status"
                    >
                      {t("chat.composer.runInterrupted")}
                    </div>
                  </Show>
                  <Show
                    when={state().duplicateCount > 1 && (!state().markdown || state().jsonResult)}
                  >
                    <div
                      class="chat-duplicate-count"
                      aria-label={t("chat.messages.duplicatesCollapsed", {
                        count: String(state().duplicateCount),
                      })}
                    >
                      ×{state().duplicateCount}
                    </div>
                  </Show>
                </div>
                <Show when={readMessageWorkContext(state().message)}>
                  <ChatLazyBoundary>
                    <MessageWorkContext message={state().message} />
                  </ChatLazyBoundary>
                </Show>
              </>
            );
          }}
        </Show>
      }
    >
      {(conflict) => {
        const entryRef = messageElements?.forKey(initialMessageKey);
        const bindEntry = elementRef((element) => {
          entryRef?.(element);
          return () => entryRef?.(undefined);
        });
        return (
          <ChatLazyBoundary>
            <WorkspaceConflictTranscriptMessage
              conflict={conflict()}
              messageKey={props.messageKey}
              entryId={props.options.entryId}
              ref={bindEntry}
            />
          </ChatLazyBoundary>
        );
      }}
    </Show>
  );
}

function MessageText(props: ContentProps) {
  const OrderedMedia = (media: { item: PositionedMedia }) => (
    <ChatLazyBoundary>
      <OrderedMessageMedia {...props} item={media.item} />
    </ChatLazyBoundary>
  );
  const prepared = createMemo(() => {
    const state = props.state();
    const options = {
      ...props.options,
      role: state.isStandaloneToolMessage && !state.renderInOrder ? "tool" : state.normalizedRole,
    };
    let text = state.bodyMarkdown;
    let media: MarkdownMedia | undefined;
    if (!state.asyncQuestions && state.renderInOrder) {
      const ordered = prepareMarkdownMedia(state.orderedContent, OrderedMedia);
      text = resolveMessageDisplayMarkdown(state.message, {
        ...state.normalizedMessage,
        content: [{ type: "text", text: ordered.markdown }],
      });
      options.assistantMessageDisclosure = state.disclosure
        ? { ...state.disclosure, markdown: text }
        : undefined;
      media = { ...ordered.media, text: state.bodyMarkdown ?? "" };
    }
    return { text, options, media, json: state.renderInOrder ? null : state.jsonResult };
  });
  return (
    <Switch>
      <Match when={props.state().asyncQuestions}>
        <ChatLazyBoundary>
          <AsyncQuestionSummary
            questions={props.state().asyncQuestions!}
            presentation={props.options.asyncQuestions!}
          />
        </ChatLazyBoundary>
      </Match>
      <Match when={prepared().json}>
        <MessageJson
          json={prepared().json!}
          messageKey={props.messageKey}
          options={prepared().options}
          markdownOptions={props.state().markdownRenderOptions}
        />
      </Match>
      <Match when={prepared().text}>
        <MessageMarkdown
          markdown={prepared().text ?? ""}
          messageKey={props.messageKey}
          options={prepared().options}
          markdownOptions={props.state().markdownRenderOptions}
          duplicateSuffix={props.state().duplicateSuffix}
          media={prepared().media}
        />
      </Match>
    </Switch>
  );
}

function MessageAvatar(props: { render?: () => JSX.Element }) {
  // Replacing the factory retires its bindings; updates inside it stay with its owner.
  return (
    <Show when={props.render} keyed>
      {(render) => render()}
    </Show>
  );
}

function BubbleContents(props: ContentProps) {
  const hasLeadingContent = () => {
    const state = props.state();
    return Boolean(
      (state.sourceRole === "assistant" && state.clawHubCards.length > 0) ||
      state.expiredPairingQrCount ||
      (state.renderInOrder ? state.supplementalImages : state.images).length ||
      state.videoPreviews.length ||
      state.omittedMedia.length ||
      (state.renderInOrder ? state.supplementalAttachments : state.cardAttachments).length,
    );
  };
  const hasTrailingContent = () => {
    const state = props.state();
    return Boolean(
      state.inlineViewBlocks.length ||
      state.hasToolCards ||
      state.failedToolCard ||
      asNullableRecord(state.m["__openclaw"])?.catalogTruncated === true,
    );
  };
  const hasText = () =>
    Boolean(props.state().bodyMarkdown || props.state().asyncQuestions || props.state().jsonResult);
  return (
    <>
      <Show when={hasLeadingContent()}>
        <ChatLazyBoundary>
          <RichBubbleBefore {...props} />
        </ChatLazyBoundary>
      </Show>
      <Show
        when={props.state().isStandaloneToolMessage && props.state().assistantViewBlocks.length > 0}
      >
        <AssistantViews {...props} />
      </Show>
      <Show when={props.state().reasoningMarkdown}>
        <ChatLazyBoundary>
          <MessageReasoning state={props.state} options={props.options} />
        </ChatLazyBoundary>
      </Show>
      <Show
        when={
          !props.state().isStandaloneToolMessage && props.state().assistantViewBlocks.length > 0
        }
      >
        <AssistantViews {...props} />
      </Show>
      <Show when={props.state().normalizedRole === "user"} fallback={<MessageText {...props} />}>
        <Show when={hasText() || props.options.avatar}>
          <div class="chat-message-avatar-anchor">
            <MessageText {...props} />
            <MessageAvatar render={props.options.avatar} />
          </div>
        </Show>
      </Show>
      <Show when={hasTrailingContent()}>
        <ChatLazyBoundary>
          <RichBubbleAfter {...props} />
        </ChatLazyBoundary>
      </Show>
    </>
  );
}
