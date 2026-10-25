import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { RecoveryEntry, RecoveryHost } from "./chat-outbox-recovery.tsx";

type DraftStore = typeof import("../../lib/chat/composer-draft-store.runtime.ts");

/** Admission and completion stay with the recovery owner across this import. */
export function* changeChatOutboxRecovery({
  host,
  owner,
  entry,
  restoring,
  isCurrent,
  setError,
  loadDraftStore,
}: {
  host: RecoveryHost;
  owner: { gatewayOwner: string; recoveryScope: string };
  entry: RecoveryEntry;
  restoring: boolean;
  isCurrent: () => boolean;
  setError: (message: string) => void;
  loadDraftStore: () => Promise<DraftStore>;
}) {
  if (!restoring) {
    // A dialog must render outside the transaction waiting for its answer.
    const confirmed: boolean = yield Promise.resolve().then(() =>
      isCurrent()
        ? showConfirmDialog({
            title: t("chat.outboxRecoveryDeleteTitle"),
            message: t("chat.outboxRecoveryDeleteConfirm"),
            details: details(entry),
            confirmLabel: t("chat.outboxRecoveryDelete"),
            danger: true,
          })
        : false,
    );
    if (!confirmed || !isCurrent()) {
      return undefined;
    }
    let result: ReturnType<typeof discardChatOutboxRecovery>;
    if ("id" in entry) {
      result = discardChatOutboxRecovery(host, entry, isCurrent);
    } else {
      const store: DraftStore = yield loadDraftStore();
      const discarded: Awaited<ReturnType<typeof store.discardDurableComposerRecovery>> =
        yield store.discardDurableComposerRecovery(owner, entry, isCurrent);
      result = discarded.status;
    }
    if (!isCurrent()) {
      return undefined;
    }
    if (result === "discarded") {
      return "discarded" as const;
    }
    setError(
      t(
        result === "conflict"
          ? "chat.outboxRecoveryDeleteConflict"
          : "chat.outboxRecoveryStorageFailed",
      ),
    );
    return undefined;
  }
  if (!isCurrent()) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  const scope = resolveUiConversationIdentity(host, host.sessionKey);
  const destination = captureChatOutboxRecoveryDestination(host, scope);
  const durableScope = { ...owner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` };
  const store: DraftStore = yield loadDraftStore();
  const before: Awaited<ReturnType<typeof store.readDurableComposerDraft>> =
    yield store.readDurableComposerDraft(durableScope);
  if (before.status === "storage-failed") {
    setError(t("chat.outboxRecoveryStorageFailed"));
    return undefined;
  }
  if (!destination || before.status === "found" || !isCurrent()) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  const confirmed: boolean = yield Promise.resolve().then(() =>
    isCurrent()
      ? showConfirmDialog({
          title: t("chat.outboxRecoveryReviewTitle"),
          message: t("chat.outboxRecoveryConfirm", {
            chat: resolveSessionDisplayName(
              scope.sessionKey,
              host.sessionsResult?.sessions.find((session) => session.key === scope.sessionKey),
            ),
          }),
          details: details(entry),
          confirmLabel: t("chat.outboxRecoveryRestore"),
        })
      : false,
  );
  if (!confirmed || !isCurrent()) {
    return undefined;
  }
  const currentDraft: Awaited<ReturnType<typeof store.readDurableComposerDraft>> =
    yield store.readDurableComposerDraft(durableScope);
  if (!isCurrent() || JSON.stringify(currentDraft) !== JSON.stringify(before)) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  let result:
    | ReturnType<typeof restoreChatOutboxRecovery>
    | Awaited<ReturnType<typeof store.restoreDurableComposerRecovery>>["status"];
  if ("id" in entry) {
    result = restoreChatOutboxRecovery(host, entry, destination, before.revision ?? 0);
  } else {
    const restored: Awaited<ReturnType<typeof store.restoreDurableComposerRecovery>> =
      yield store.restoreDurableComposerRecovery(
        durableScope,
        entry,
        before.revision ?? 0,
        before.writeId,
        () =>
          isCurrent() &&
          JSON.stringify(captureChatOutboxRecoveryDestination(host, scope)) ===
            JSON.stringify(destination),
        destination.revision,
      );
    result = restored.status;
  }
  if (result === "restored" || result === "persisted") {
    return "restored" as const;
  }
  setError(
    t(result === "conflict" ? "chat.outboxRecoveryConflict" : "chat.outboxRecoveryStorageFailed"),
  );
  return undefined;
}

function details(entry: RecoveryEntry) {
  const session = "id" in entry ? entry.session : null;
  const text = "id" in entry ? entry.session.draft : entry.text;
  const { goalMode: goal, replyTarget: reply } = "id" in entry ? entry.session : entry;
  const attachmentNames = "id" in entry ? [] : entry.attachmentNames;
  return [
    text?.trim(),
    goal ? t("chat.outboxRecoveryGoal") : "",
    reply ? t("chat.outboxRecoveryReply", { text: reply.text }) : "",
    attachmentNames.length
      ? t("chat.outboxRecoveryAttachments", { files: attachmentNames.join(", ") })
      : "",
    ...(session?.queue ?? []).flatMap((item) => [
      item.text.trim(),
      item.attachments?.length
        ? t("chat.outboxRecoveryAttachments", {
            files: item.attachments
              .map((attachment) => attachment.fileName ?? attachment.mimeType)
              .join(", "),
          })
        : "",
      item.attachmentStorageError ? t("chat.outboxRecoveryAttachmentMissing") : "",
    ]),
  ]
    .filter(Boolean)
    .join("\n\n");
}
