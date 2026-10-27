import { createMemo, lazy, Match, Show, Switch } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { SystemLine } from "./chat-divider.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

type ChatNoticeProps = {
  item: Extract<ChatItem, { kind: "notice" }>;
  onPermissionRetry?: (message: string) => void;
  recovery?: Pick<
    ChatThreadProps,
    "failureActionsRunId" | "runActive" | "runWorking" | "onRetryRun" | "onDismissPendingInput"
  >;
};

// Text-only notices paint with their transcript row; only interactive cards load later.
const ChatPermissionCard = lazy(() => import("./chat-permission-card.tsx"), {
  export: "ChatPermissionCard",
});
const ChatSkillLearnedNotice = lazy(() => import("./chat-skill-learned-notice.tsx"), {
  export: "ChatSkillLearnedNotice",
});

function NoticeBody(props: { text: string }) {
  return (
    <MarkdownHtml
      class="chat-text chat-notice__body"
      dir={detectTextDirection(props.text)}
      markdown={props.text}
      options={{ codeBlockChrome: "none" }}
    />
  );
}

/** Context injected mid-run reads as part of the agent's turn, not as a session divider. */
function InlineNotice(props: ChatNoticeProps) {
  return (
    <details
      class="chat-notice-inline"
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
    >
      <summary>
        <span class="chat-notice-inline__icon" aria-hidden="true">
          <Icon name={props.item.icon ?? "cpu"} />
        </span>
        <strong class="chat-notice-inline__label">{props.item.label}</strong>
        <Show when={props.item.showTimestamp}>
          <span class="chat-notice-inline__time">{formatTimeMs(props.item.timestamp)}</span>
        </Show>
        <span class="chat-notice-inline__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <NoticeBody text={props.item.text} />
    </details>
  );
}

function OrdinaryNotice(props: ChatNoticeProps) {
  return (
    <div
      class={[
        "chat-notice",
        props.item.tone === "danger" ? "chat-notice--danger callout danger" : "",
      ]}
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      role={props.item.tone === "danger" ? "alert" : undefined}
    >
      <Show when={props.item.label}>
        <SystemLine
          icon={props.item.icon}
          label={props.item.label!}
          metric={props.item.showTimestamp ? formatTimeMs(props.item.timestamp) : undefined}
        />
      </Show>
      <Show when={props.item.text}>
        <NoticeBody text={props.item.text} />
      </Show>
      <Show when={props.item.retiredPendingInput}>
        {(retired) => (
          <Show when={props.recovery?.onDismissPendingInput}>
            {(dismiss) => (
              <div class="chat-notice__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  aria-label={t(
                    retired().status === "interrupted"
                      ? "chat.pendingInputs.dismissInterrupted"
                      : "chat.pendingInputs.dismissCancelled",
                    { preview: retired().preview },
                  )}
                  onClick={() => dismiss()(retired().id)}
                >
                  {t("chat.pendingInputs.dismiss")}
                </button>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

function ChatNoticeDetails(props: ChatNoticeProps) {
  return (
    <Switch fallback={<OrdinaryNotice item={props.item} recovery={props.recovery} />}>
      <Match when={props.item.permissionMissing}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatLazyBoundary>
            <ChatPermissionCard
              request={props.item.permissionMissing!}
              onRetry={props.onPermissionRetry}
            />
          </ChatLazyBoundary>
        </div>
      </Match>
      <Match when={props.item.collapsedBody && props.item.text}>
        <InlineNotice item={props.item} />
      </Match>
      <Match when={props.item.skillChanges}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatLazyBoundary>
            <ChatSkillLearnedNotice notice={props.item.skillChanges} />
          </ChatLazyBoundary>
        </div>
      </Match>
    </Switch>
  );
}

function FailureNotice(props: ChatNoticeProps) {
  const failure = () => props.item.runError!;
  const actions = createMemo(() => {
    const runId = failure().runId;
    const recovery = props.recovery;
    if (
      !recovery ||
      runId !== recovery.failureActionsRunId ||
      recovery.runActive ||
      recovery.runWorking
    ) {
      return undefined;
    }
    return {
      onRetry: recovery.onRetryRun ? () => recovery.onRetryRun?.(runId) : undefined,
    };
  });
  return (
    <div
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      data-run-failure={failure().runId}
    >
      <ChatRunFailureNotice
        summary={failure().summary}
        repeatCount={props.item.repeatCount}
        onRetry={actions()?.onRetry}
      />
    </div>
  );
}

export function ChatNotice(props: ChatNoticeProps) {
  return (
    <Show when={props.item.runError} fallback={<ChatNoticeDetails {...props} />}>
      <FailureNotice item={props.item} recovery={props.recovery} />
    </Show>
  );
}
