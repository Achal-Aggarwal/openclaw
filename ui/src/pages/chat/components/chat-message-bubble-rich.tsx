import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, lazy, For, Match, Show, Switch, type Accessor, useContext } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { prepareMarkdownJsonOptions } from "../../../lib/markdown-json.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { ChatBubbleActivity } from "./chat-bubble-activity-view.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { OmittedMedia, PairingQrNotices } from "./chat-message-attachment-status-solid.tsx";
import type { MessageContentProps as ContentProps } from "./chat-message-bubble-presentation.ts";
import { BubbleToolCards, InlineToolCards, ToolMessage } from "./chat-message-bubble-tools.tsx";
import {
  AssistantAttachments,
  ChatClawHubCard,
  MessageAttachment,
  MessageImages,
} from "./chat-message-deferred.tsx";
import type { PositionedMedia } from "./chat-message-media-markdown.ts";
import type { AttachmentItem } from "./chat-message-media.ts";
import { MarkdownText } from "./chat-message-text-view.tsx";

const PluginInlineView = lazy(() => import("../../../plugins/control-ui-inline-view.tsx"), {
  export: "PluginInlineView",
});

export function RichBubbleFrame(props: ContentProps & { renderContents: () => JSX.Element }) {
  return (
    <Switch>
      <Match when={props.state().voiceTranscript}>
        <ChatBubbleActivity
          label={t("chat.messages.voiceTranscript")}
          open={props.options.searchResult}
        >
          {props.renderContents()}
        </ChatBubbleActivity>
      </Match>
      <Match when={props.state().onlyToolCards}>
        <InlineToolCards
          cards={props.state().toolCards}
          options={props.state().toolRenderOptions}
        />
      </Match>
      <Match when={props.state().isStandaloneToolMessage}>
        <ToolMessage {...props} renderContents={() => props.renderContents()} />
      </Match>
      <Match when={true}>{props.renderContents()}</Match>
    </Switch>
  );
}

export function OrderedMessageMedia(props: ContentProps & { item: PositionedMedia }) {
  return (
    <Show
      when={props.item.type === "image" ? props.item.image : undefined}
      fallback={
        <AssistantAttachments
          attachments={props.item.type === "image" ? [] : [props.item]}
          options={props.state().imageRenderOptions}
          onOpenSidebar={props.onOpenSidebar}
          onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
        />
      }
    >
      {(image) => <MessageImages images={[image()]} options={props.state().imageRenderOptions} />}
    </Show>
  );
}

function VideoPreview(props: ContentProps & { item: Accessor<AttachmentItem | undefined> }) {
  const parentPresented = useContext(ContentPresentation);
  // Retained rows can resume with equal props; the parent owns that presentation transition.
  const presented = usePanePresentation(
    () => parentPresented() && (props.options.transcriptVisible ?? true),
  );
  return (
    <div class="chat-image-frame chat-video-preview">
      <Show when={props.item()}>
        {(item) => (
          <Show when={presented()}>
            <MessageAttachment
              item={item()}
              options={props.state().imageRenderOptions}
              onOpenSidebar={props.onOpenSidebar}
              onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
              presentation="preview"
            />
          </Show>
        )}
      </Show>
    </div>
  );
}

export function MessageReasoning(props: Pick<ContentProps, "state" | "options">) {
  const options = createMemo(() =>
    prepareMarkdownJsonOptions(props.state().reasoningMarkdown ?? "", {
      codeBlockInteraction: "interactive",
    }),
  );
  const content = (
    <MarkdownText
      class="chat-thinking"
      content={toSanitizedMarkdownHtml(props.state().reasoningMarkdown ?? "", options())}
    />
  );
  return (
    <Show when={props.options.bubbleMode} fallback={content}>
      <ChatBubbleActivity label={t("chat.view.reasoning")}>{content}</ChatBubbleActivity>
    </Show>
  );
}

export function RichBubbleBefore(props: ContentProps) {
  const previewCount = createMemo(() => props.state().videoPreviews.length);
  const previews = createMemo(() =>
    Array.from({ length: previewCount() }, (_, index) => (
      <VideoPreview {...props} item={() => props.state().videoPreviews[index]} />
    )),
  );
  return (
    <>
      <Show when={props.state().sourceRole === "assistant"}>
        <For each={props.state().clawHubCards} keyed={(card) => card.id}>
          {(card) => <ChatClawHubCard recommendation={card()} agentId={props.options.agentId} />}
        </For>
      </Show>
      <PairingQrNotices count={props.state().expiredPairingQrCount} />
      <MessageImages
        images={
          props.state().renderInOrder ? props.state().supplementalImages : props.state().images
        }
        options={props.state().imageRenderOptions}
        previews={previews()}
      />
      <OmittedMedia items={props.state().omittedMedia} />
      <AssistantAttachments
        attachments={
          props.state().renderInOrder
            ? props.state().supplementalAttachments
            : props.state().cardAttachments
        }
        options={props.state().imageRenderOptions}
        onOpenSidebar={props.onOpenSidebar}
        onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
        inlinePlayback={props.state().normalizedRole === "assistant"}
        inlineComments={props.state().inlineComments}
      />
    </>
  );
}

export function RichBubbleAfter(props: ContentProps) {
  return (
    <>
      <For each={props.state().inlineViewBlocks} keyed={(block) => block.toolCallId}>
        {(block) => (
          <ChatLazyBoundary>
            <PluginInlineView
              block={block()}
              sessionKey={props.options.sessionKey ?? ""}
              agentId={props.options.agentId}
              presented={props.options.mediaReadAllowed !== false && props.options.presented}
            />
          </ChatLazyBoundary>
        )}
      </For>
      <Show when={props.state().hasToolCards || props.state().failedToolCard}>
        <BubbleToolCards {...props} />
      </Show>
      <Show
        when={
          !props.state().hasToolCards &&
          asNullableRecord(asNullableRecord(props.state().message)?.["__openclaw"])
            ?.catalogTruncated === true
        }
      >
        <p role="status">{t("chat.catalogOutputTruncated")}</p>
      </Show>
    </>
  );
}
