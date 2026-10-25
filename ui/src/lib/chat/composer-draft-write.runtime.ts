import type { DurableComposerDraft, DurableComposerDraftScope } from "./chat-types.ts";
import { notifyDurableComposerDraftChanges } from "./composer-draft-changes.ts";
import { parseStoredDraft, type StoredDurableComposerDraft } from "./composer-draft-store-codec.ts";
import {
  CHAT_SCOPE_PREFIX,
  MAX_ACTIVE_DRAFTS_PER_OWNER,
  MAX_DURABLE_DRAFT_ATTACHMENT_BYTES,
  OWNER_INDEX,
  expiredRecord,
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

async function pruneOwnerRecords(
  store: IDBObjectStore,
  currentOwnerKey: string,
  now: number,
): Promise<void> {
  const values: unknown[] = await requestResult(store.index(OWNER_INDEX).getAll(currentOwnerKey));
  const records = values.map(parseStoredDraft).filter((record) => record !== null);
  const active: StoredDurableComposerDraft[] = [];
  for (const record of records) {
    const expired = expiredRecord(record, now);
    if (expired === null) {
      store.delete(record.key);
      continue;
    }
    if (expired) {
      store.put(expired);
      continue;
    }
    if (isActiveDraft(record) && !isLegacyChatDraft(record)) {
      active.push(record);
    }
  }
  active.sort((left, right) => right.updatedAt - left.updatedAt);
  for (const record of active.slice(MAX_ACTIVE_DRAFTS_PER_OWNER)) {
    store.put(tombstone(record, now));
  }
}

export async function writeDurableComposerDraft(
  scope: DurableComposerDraftScope,
  draft: DurableComposerDraft,
  options: {
    expectedRevision: number;
    expectedWriteId?: string;
    expectedWriteIds?: readonly string[];
    writeId: string;
  },
): Promise<DurableComposerDraftWriteResult> {
  const payloadBytes = draft.attachments.reduce((total, attachment) => {
    return total + attachment.blob.size;
  }, 0);
  if (payloadBytes > MAX_DURABLE_DRAFT_ATTACHMENT_BYTES) {
    const fallbackResult = await writeDurableComposerDraft(
      scope,
      { ...draft, attachments: [] },
      options,
    );
    return fallbackResult.status === "persisted"
      ? {
          status: "payload-too-large",
          revision: fallbackResult.revision,
          writeId: fallbackResult.writeId,
        }
      : fallbackResult;
  }
  return withDraftStore(async (store) => {
    const key = recordKey(scope);
    const current = parseStoredDraft(await requestResult(store.get(key)));
    if (current?.revision === draft.revision) {
      store.transaction.abort();
      return current.writeId === options.writeId
        ? { status: "persisted", revision: current.revision, writeId: current.writeId }
        : { status: "conflict" };
    }
    const expectedCurrent = current
      ? (current.revision === options.expectedRevision &&
          (options.expectedWriteId === undefined || current.writeId === options.expectedWriteId)) ||
        options.expectedWriteIds?.includes(current.writeId) === true
      : options.expectedRevision === 0 && options.expectedWriteId === undefined;
    if (!expectedCurrent || (current?.revision ?? 0) > draft.revision) {
      store.transaction.abort();
      return { status: "conflict" };
    }
    const now = Date.now();
    const record: StoredDurableComposerDraft = {
      key,
      ownerKey: ownerKey(scope),
      gatewayOwner: scope.gatewayOwner,
      recoveryScope: scope.recoveryScope,
      scopeKey: scope.scopeKey,
      revision: draft.revision,
      text: draft.text,
      ...(draft.mentions?.length ? { mentions: draft.mentions } : {}),
      ...(draft.goalMode ? { goalMode: draft.goalMode } : {}),
      ...(draft.replyTarget ? { replyTarget: draft.replyTarget } : {}),
      ...(draft.modelSelection ? { modelSelection: draft.modelSelection } : {}),
      attachments: draft.attachments,
      ...(draft.questionDrafts?.length ? { questionDrafts: draft.questionDrafts } : {}),
      updatedAt: now,
      writeId: options.writeId,
    };
    store.put(record);
    await pruneOwnerRecords(store, record.ownerKey, now);
    await transactionComplete(store.transaction);
    notifyDurableComposerDraftChanges();
    return { status: "persisted", revision: draft.revision, writeId: options.writeId };
  });
}

export async function retireDurableComposerDraft(
  scope: DurableComposerDraftScope,
  minimumRevision = 0,
  retireBeforeRevision?: number,
): Promise<DurableComposerDraftWriteResult> {
  return withDraftStore(async (store) => {
    const now = Date.now();
    const result = await retireDurableDraftInStore(
      store,
      scope,
      minimumRevision,
      retireBeforeRevision,
      now,
    );
    if (result.status === "conflict") {
      store.transaction.abort();
      return result;
    }
    await pruneOwnerRecords(store, ownerKey(scope), now);
    await transactionComplete(store.transaction);
    notifyDurableComposerDraftChanges();
    return result;
  });
}

async function retireDurableDraftInStore(
  store: IDBObjectStore,
  scope: DurableComposerDraftScope,
  minimumRevision: number,
  retireBeforeRevision: number | undefined,
  now: number,
): Promise<DurableComposerDraftWriteResult> {
  if (scope.scopeKey.startsWith(CHAT_SCOPE_PREFIX)) {
    await retireDurableDraftInStore(
      store,
      { ...scope, scopeKey: `questions:v1:${scope.scopeKey}` },
      minimumRevision,
      retireBeforeRevision,
      now,
    );
  }
  const key = recordKey(scope);
  const current = parseStoredDraft(await requestResult(store.get(key)));
  if (retireBeforeRevision !== undefined && (current?.revision ?? 0) >= retireBeforeRevision) {
    return { status: "conflict" };
  }
  const revision = nextFenceRevision(Math.max(minimumRevision, current?.revision ?? 0));
  const writeId = `retired:${revision}`;
  store.put({
    key,
    ownerKey: ownerKey(scope),
    gatewayOwner: scope.gatewayOwner,
    recoveryScope: scope.recoveryScope,
    scopeKey: scope.scopeKey,
    revision,
    text: "",
    attachments: [],
    questionDrafts: undefined,
    updatedAt: now,
    writeId,
  } satisfies StoredDurableComposerDraft);
  return { status: "persisted", revision, writeId };
}

export async function retireDurableComposerDrafts(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
  retirements: readonly {
    scopeKey: string;
    minimumRevision: number;
    retireBeforeRevision: number;
  }[],
): Promise<"completed" | "storage-failed"> {
  const result = await withDraftStore(async (store) => {
    const now = Date.now();
    for (const retirement of retirements) {
      await retireDurableDraftInStore(
        store,
        { ...owner, scopeKey: retirement.scopeKey },
        retirement.minimumRevision,
        retirement.retireBeforeRevision,
        now,
      );
    }
    await pruneOwnerRecords(store, ownerKey(owner), now);
    await transactionComplete(store.transaction);
    notifyDurableComposerDraftChanges();
    return { status: "completed" };
  });
  return result.status;
}
