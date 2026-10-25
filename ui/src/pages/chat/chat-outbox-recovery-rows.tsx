import { createMemo, For } from "solid-js";
import {
  parseStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { RecoveryEntry, RecoveryHost } from "./chat-outbox-recovery.tsx";

function preview(entry: RecoveryEntry) {
  const text =
    "id" in entry
      ? entry.session.draft || entry.session.queue?.find((item) => item.text.trim())?.text
      : entry.text;
  if (text?.trim()) {
    return text.trim();
  }
  const attachments =
    "id" in entry
      ? (entry.session.queue ?? [])
          .flatMap((item) => item.attachments ?? [])
          .map((a) => a.fileName ?? a.mimeType)
      : entry.attachmentNames;
  if (attachments.length) {
    return t("chat.outboxRecoveryAttachments", { files: attachments.join(", ") });
  }
  const { goalMode: goal, replyTarget: reply } = "id" in entry ? entry.session : entry;
  if (goal) {
    return t("chat.outboxRecoveryGoal");
  }
  if (reply) {
    return t("chat.outboxRecoveryReply", { text: reply.text });
  }
  return t("chat.outboxRecoveryQueued");
}

function RecoveryRow(props: {
  entry: RecoveryEntry;
  host: RecoveryHost | undefined;
  busy: boolean;
  canRecover: boolean;
  onChange: (entry: RecoveryEntry, action: "restore" | "discard") => Promise<void>;
}) {
  const view = createMemo(() => {
    const entry = props.entry;
    const scope = parseStoredChatOutboxScope("id" in entry ? entry.sourceScopeKey : entry.scopeKey);
    const currentScope = props.host
      ? resolveUiConversationIdentity(props.host, props.host.sessionKey)
      : undefined;
    // Old global/main buckets do not identify a conversation. Never use today's
    // defaults to invent their source or show an inaccessible chat's raw key.
    const source =
      scope &&
      !["global", "main"].includes(scope.sessionKey) &&
      (!currentScope || storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(currentScope))
        ? props.host?.sessionsResult?.sessions.find((row) => row.key === scope.sessionKey)
        : undefined;
    const updatedAt = "id" in entry ? entry.session.updatedAt : entry.updatedAt;
    const queued = "id" in entry && Boolean(entry.session.queue?.length);
    return {
      source,
      updatedAt,
      queued,
      sourceLabel: source ? resolveSessionDisplayName(source.key, source) : "",
    };
  });
  return (
    <div
      class="chat-outbox-recovery-row"
      title={
        view().updatedAt > 0
          ? t("chat.outboxRecoveryUpdated", {
              time: formatDateTimeMs(view().updatedAt, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })
          : ""
      }
    >
      <span class="chat-outbox-recovery__kind">
        {t(view().queued ? "chat.outboxRecoveryQueued" : "chat.outboxRecoveryDraft")}
      </span>
      <span class="chat-outbox-recovery__preview">{preview(props.entry)}</span>
      {view().source ? (
        <span class="chat-outbox-recovery__source">
          {t("chat.outboxRecoverySource", {
            chat: view().sourceLabel,
          })}
        </span>
      ) : null}
      <div class="chat-outbox-recovery__actions">
        <button
          class="btn btn--sm"
          disabled={props.busy || !props.canRecover}
          onClick={() => void props.onChange(props.entry, "restore")}
        >
          {t("chat.outboxRecoveryRestore")}
        </button>
        <button
          class="btn btn--sm"
          disabled={props.busy || !props.canRecover}
          onClick={() => void props.onChange(props.entry, "discard")}
        >
          {t("chat.outboxRecoveryDelete")}
        </button>
      </div>
    </div>
  );
}

export function RecoveryRows(props: {
  rows: RecoveryEntry[];
  host: RecoveryHost | undefined;
  busy: boolean;
  canRecover: boolean;
  onChange: (entry: RecoveryEntry, action: "restore" | "discard") => Promise<void>;
}) {
  return (
    <For
      each={props.rows}
      keyed={(entry) => ("id" in entry ? `outbox:${entry.id}` : `draft:${entry.scopeKey}`)}
    >
      {(entry) => (
        <RecoveryRow
          entry={entry()}
          host={props.host}
          busy={props.busy}
          canRecover={props.canRecover}
          onChange={props.onChange}
        />
      )}
    </For>
  );
}
