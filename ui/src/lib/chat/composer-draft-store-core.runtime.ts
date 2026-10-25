import { listen } from "../reactive/listener.ts";
import type { DurableComposerDraft, DurableComposerDraftScope } from "./chat-types.ts";
import { notifyDurableComposerDraftChanges } from "./composer-draft-changes.ts";
import { parseStoredDraft, type StoredDurableComposerDraft } from "./composer-draft-store-codec.ts";
import { openControlUiDatabase, transactionComplete } from "./control-ui-database.runtime.ts";

export const STORE_NAME = "composerDrafts";
export const OWNER_INDEX = "ownerKey";
export const CHAT_SCOPE_PREFIX = "chat:v3:";
export const DRAFT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_ACTIVE_DRAFTS_PER_OWNER = 20;
export const MAX_DURABLE_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type ReadDurableComposerDraft = DurableComposerDraft & { writeId: string };

export type DurableComposerDraftReadResult =
  | { status: "found"; draft: ReadDurableComposerDraft }
  | { status: "not-found"; revision?: number; writeId?: string }
  | { status: "storage-failed" };

export type DurableComposerDraftWriteResult =
  | { status: "persisted"; revision?: number; writeId?: string }
  | { status: "conflict" }
  | { status: "payload-too-large"; revision?: number; writeId?: string }
  | { status: "storage-failed" };

let lastFenceRevision = 0;

let sweptDatabase: IDBDatabase | null = null;
export async function openDraftDatabase(): Promise<IDBDatabase> {
  const database = await openControlUiDatabase();
  if (sweptDatabase !== database) {
    sweptDatabase = database;
    // Draft expiry never visits outbox payloads: live queues have no age limit.
    globalThis.setTimeout(() => void sweepExpiredRecords(database).catch(() => undefined), 0);
  }
  return database;
}

export async function withDraftStore<const Result extends { status: string }>(
  operation: (store: IDBObjectStore) => Promise<Result>,
  abortOnError = false,
): Promise<Result | { status: "storage-failed" }> {
  let transaction: IDBTransaction | undefined;
  try {
    const database = await openDraftDatabase();
    transaction = database.transaction(STORE_NAME, "readwrite");
    return await operation(transaction.objectStore(STORE_NAME));
  } catch {
    if (abortOnError) {
      // Synchronous clone/validation errors must not commit half a recovery transfer.
      try {
        transaction?.abort();
      } catch {
        /* The transaction already settled. */
      }
    }
    return { status: "storage-failed" };
  }
}

export function ownerKey(
  scope: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope]);
}

export function recordKey(scope: DurableComposerDraftScope): string {
  return JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
}

export function nextFenceRevision(baseline: number): number {
  const revision = Math.max(Date.now(), baseline + 1, lastFenceRevision + 1);
  lastFenceRevision = revision;
  return revision;
}

export function isActiveDraft(record: StoredDurableComposerDraft): boolean {
  return Boolean(
    record.text ||
    record.goalMode ||
    record.replyTarget ||
    record.modelSelection ||
    record.attachments.length > 0 ||
    record.questionDrafts?.length,
  );
}

export function tombstone(
  record: StoredDurableComposerDraft,
  now: number,
): StoredDurableComposerDraft {
  const revision = nextFenceRevision(record.revision);
  return {
    ...record,
    revision,
    text: "",
    mentions: undefined,
    goalMode: undefined,
    replyTarget: undefined,
    modelSelection: undefined,
    attachments: [],
    questionDrafts: undefined,
    updatedAt: now,
    writeId: `fence:${revision}`,
  };
}

export function expiredRecord(
  record: StoredDurableComposerDraft,
  now: number,
): StoredDurableComposerDraft | null | undefined {
  // Old chat identities may have collapsed main into global. Keep these bounded
  // drafts (including blobs) until migration or explicit destination confirmation.
  if (isLegacyChatDraft(record) || record.updatedAt > now - DRAFT_EXPIRY_MS) {
    return undefined;
  }
  return isActiveDraft(record) ? tombstone(record, now) : null;
}

async function sweepExpiredRecords(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const now = Date.now();
  const request = store.openCursor();
  let changed = false;
  // Cursor continuation reuses this request until the owning transaction finishes.
  listen(request, "success", () => {
    try {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      const record = parseStoredDraft(cursor.value);
      const expired = record ? expiredRecord(record, now) : undefined;
      // Readers may have cached active presence before the draft expired.
      if (expired === null) {
        cursor.delete();
        changed = true;
      } else if (expired) {
        cursor.update(expired);
        changed = true;
      }
      cursor.continue();
    } catch {
      transaction.abort();
    }
  });
  await transactionComplete(transaction);
  if (changed) {
    notifyDurableComposerDraftChanges();
  }
}

export function isLegacyChatDraft(record: StoredDurableComposerDraft): boolean {
  return (
    !record.scopeKey.startsWith(CHAT_SCOPE_PREFIX) &&
    !record.scopeKey.startsWith("questions:v1:") &&
    record.scopeKey.includes("\u0000agent:") &&
    isActiveDraft(record)
  );
}
