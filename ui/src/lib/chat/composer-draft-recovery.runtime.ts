import type {
  ChatGoalDraftMode,
  ChatReplyTarget,
  DurableComposerDraftScope,
} from "./chat-types.ts";
import { notifyDurableComposerDraftChanges } from "./composer-draft-changes.ts";
import { parseStoredDraft } from "./composer-draft-store-codec.ts";
import {
  CHAT_SCOPE_PREFIX,
  MAX_ACTIVE_DRAFTS_PER_OWNER,
  OWNER_INDEX,
  isActiveDraft,
  isLegacyChatDraft,
  nextFenceRevision,
  ownerKey,
  recordKey,
  tombstone,
  withDraftStore,
  type DurableComposerDraftWriteResult,
} from "./composer-draft-store-core.runtime.ts";
import { requestResult, transactionComplete } from "./control-ui-database.runtime.ts";
import { parseStoredChatOutboxScope, storedChatOutboxScopeKey } from "./outbox-store.ts";

export type DurableComposerRecoveryEntry = {
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">;
  scopeKey: string;
  revision: number;
  writeId: string;
  updatedAt: number;
  text: string;
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  attachmentNames: string[];
};

/** One transaction moves identifiable legacy rows; collisions and global stay unsent. */
export async function prepareDurableComposerRecovery(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
): Promise<
  { status: "ready"; entries: DurableComposerRecoveryEntry[] } | { status: "storage-failed" }
> {
  return withDraftStore(async (store) => {
    const values: unknown[] = await requestResult(store.index(OWNER_INDEX).getAll(ownerKey(owner)));
    const records = values.map(parseStoredDraft).filter((record) => record !== null);
    const entries: DurableComposerRecoveryEntry[] = [];
    let changed = false;
    let activeCount = records.filter(
      (record) => isActiveDraft(record) && !isLegacyChatDraft(record),
    ).length;
    for (const record of records) {
      if (!isLegacyChatDraft(record)) {
        continue;
      }
      if (
        record.gatewayOwner !== owner.gatewayOwner ||
        record.recoveryScope !== owner.recoveryScope
      ) {
        throw new Error("Composer recovery owner mismatch");
      }
      const originalScope = parseStoredChatOutboxScope(record.scopeKey);
      const identifiable = originalScope && !["global", "main"].includes(originalScope.sessionKey);
      const scope = {
        ...owner,
        scopeKey: `${CHAT_SCOPE_PREFIX}${originalScope ? storedChatOutboxScopeKey(originalScope) : record.scopeKey}`,
      };
      const destination = identifiable
        ? await requestResult(store.get(recordKey(scope)))
        : undefined;
      const retired = parseStoredDraft(destination);
      // Only an exact known target can retire its older draft. Today's config
      // cannot identify an old global bucket or retarget a qualified main key.
      if (
        identifiable &&
        retired &&
        !isActiveDraft(retired) &&
        retired.revision > record.revision
      ) {
        store.put(tombstone(record, Date.now()));
      } else if (
        identifiable &&
        activeCount < MAX_ACTIVE_DRAFTS_PER_OWNER &&
        destination === undefined
      ) {
        store.put({
          ...record,
          key: recordKey(scope),
          scopeKey: scope.scopeKey,
          updatedAt: Date.now(),
        });
        activeCount++;
        store.put(tombstone(record, Date.now()));
        changed = true;
      } else {
        entries.push({
          owner: { gatewayOwner: record.gatewayOwner, recoveryScope: record.recoveryScope },
          scopeKey: record.scopeKey,
          revision: record.revision,
          writeId: record.writeId,
          updatedAt: record.updatedAt,
          text: record.text,
          ...(record.goalMode ? { goalMode: record.goalMode } : {}),
          ...(record.replyTarget ? { replyTarget: record.replyTarget } : {}),
          attachmentNames: record.attachments.map((a) => a.fileName ?? a.mimeType),
        });
      }
    }
    await transactionComplete(store.transaction);
    if (changed) {
      notifyDurableComposerDraftChanges();
    }
    return { status: "ready", entries };
  }, true);
}

/** Confirmed deletion retains a revision fence, but releases the draft's Blob bytes. */
export async function discardDurableComposerRecovery(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
  source: DurableComposerRecoveryEntry,
  isCurrent: () => boolean,
): Promise<{ status: "discarded" | "conflict" | "storage-failed" }> {
  // Check authority before opening the database as well as after reading the source.
  try {
    if (
      !isCurrent() ||
      source.owner.gatewayOwner !== owner.gatewayOwner ||
      source.owner.recoveryScope !== owner.recoveryScope
    ) {
      return { status: "conflict" };
    }
  } catch {
    return { status: "storage-failed" };
  }
  return withDraftStore(async (store) => {
    const scope = { ...owner, scopeKey: source.scopeKey };
    const original = parseStoredDraft(await requestResult(store.get(recordKey(scope))));
    if (
      !original ||
      !isLegacyChatDraft(original) ||
      original.gatewayOwner !== owner.gatewayOwner ||
      original.recoveryScope !== owner.recoveryScope ||
      original.scopeKey !== source.scopeKey ||
      original.key !== recordKey(scope) ||
      original.ownerKey !== ownerKey(owner) ||
      original.revision !== source.revision ||
      original.writeId !== source.writeId ||
      !isCurrent()
    ) {
      store.transaction.abort();
      return { status: "conflict" };
    }
    store.put(tombstone(original, Date.now()));
    await transactionComplete(store.transaction);
    notifyDurableComposerDraftChanges();
    return { status: "discarded" };
  }, true);
}

export async function restoreDurableComposerRecovery(
  destination: DurableComposerDraftScope,
  source: DurableComposerRecoveryEntry,
  expectedDestinationRevision: number,
  expectedDestinationWriteId: string | undefined,
  isCurrent: () => boolean,
  minimumRevision: number,
): Promise<DurableComposerDraftWriteResult> {
  return withDraftStore(async (store) => {
    const original = parseStoredDraft(
      await requestResult(store.get(recordKey({ ...destination, scopeKey: source.scopeKey }))),
    );
    const current = parseStoredDraft(await requestResult(store.get(recordKey(destination))));
    if (
      !isCurrent() ||
      !original ||
      !isLegacyChatDraft(original) ||
      original.gatewayOwner !== destination.gatewayOwner ||
      original.recoveryScope !== destination.recoveryScope ||
      original.revision !== source.revision ||
      original.writeId !== source.writeId ||
      (current?.revision ?? 0) !== expectedDestinationRevision ||
      current?.writeId !== expectedDestinationWriteId ||
      (current && isActiveDraft(current))
    ) {
      store.transaction.abort();
      return { status: "conflict" };
    }
    const revision = nextFenceRevision(
      Math.max(minimumRevision, original.revision, current?.revision ?? 0),
    );
    store.put({
      ...original,
      key: recordKey(destination),
      scopeKey: destination.scopeKey,
      revision,
      writeId: `recovered:${revision}`,
      updatedAt: Date.now(),
    });
    store.put(tombstone(original, Date.now()));
    await transactionComplete(store.transaction);
    notifyDurableComposerDraftChanges();
    return { status: "persisted", revision };
  }, true);
}
