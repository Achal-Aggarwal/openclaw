// Keep read/presence probes small; recovery and writes load at their asynchronous operation.
import type { DurableChatDraftPresence, DurableComposerDraftScope } from "./chat-types.ts";
import { notifyDurableComposerDraftChanges } from "./composer-draft-changes.ts";
import { parseStoredDraft } from "./composer-draft-store-codec.ts";
import {
  CHAT_SCOPE_PREFIX,
  DRAFT_EXPIRY_MS,
  OWNER_INDEX,
  STORE_NAME,
  expiredRecord,
  isActiveDraft,
  openDraftDatabase,
  ownerKey,
  recordKey,
  withDraftStore,
  type DurableComposerDraftReadResult,
} from "./composer-draft-store-core.runtime.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";

export type {
  DurableChatDraftPresence,
  DurableComposerDraft,
  DurableComposerDraftScope,
  DurableDraftModelSelection,
  DurableQuestionDraft,
} from "./chat-types.ts";
export type { DurableComposerRecoveryEntry } from "./composer-draft-recovery.runtime.ts";
export { subscribeDurableComposerDraftChanges } from "./composer-draft-changes.ts";

export async function listDurableChatDraftPresence(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
): Promise<
  | { status: "ready"; presence: ReadonlyMap<string, DurableChatDraftPresence> }
  | { status: "storage-failed" }
> {
  try {
    const database = await openControlUiDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const values: unknown[] = await requestResult(store.index(OWNER_INDEX).getAll(ownerKey(owner)));
    const presence = new Map<string, DurableChatDraftPresence>();
    for (const value of values) {
      const record = parseStoredDraft(value);
      if (
        !record ||
        record.gatewayOwner !== owner.gatewayOwner ||
        record.recoveryScope !== owner.recoveryScope ||
        !record.scopeKey.startsWith(CHAT_SCOPE_PREFIX)
      ) {
        continue;
      }
      presence.set(
        record.scopeKey.slice(CHAT_SCOPE_PREFIX.length),
        record.updatedAt > Date.now() - DRAFT_EXPIRY_MS
          ? { revision: record.revision, active: isActiveDraft(record) }
          : // Expiry will mint a newer clear fence on read; hide the pending clear now.
            { revision: Number.MAX_SAFE_INTEGER, active: false },
      );
    }
    await transactionComplete(transaction);
    return { status: "ready", presence };
  } catch {
    return { status: "storage-failed" };
  }
}

export async function readDurableComposerDraft(
  scope: DurableComposerDraftScope,
): Promise<DurableComposerDraftReadResult> {
  return withDraftStore(async (store) => {
    const value = await requestResult(store.get(recordKey(scope)));
    const record = parseStoredDraft(value);
    const now = Date.now();
    if (
      record &&
      (record.gatewayOwner !== scope.gatewayOwner ||
        record.recoveryScope !== scope.recoveryScope ||
        record.scopeKey !== scope.scopeKey)
    ) {
      store.transaction.abort();
      return { status: "storage-failed" };
    }
    const expired = record ? expiredRecord(record, now) : undefined;
    const current = expired === undefined ? record : expired;
    if (expired === null || (!record && value !== undefined)) {
      store.delete(record?.key ?? recordKey(scope));
    } else if (expired) {
      store.put(expired);
    }
    await transactionComplete(store.transaction);
    if (expired !== undefined) {
      notifyDurableComposerDraftChanges();
    }
    if (!current || !isActiveDraft(current)) {
      return {
        status: "not-found",
        ...(current ? { revision: current.revision, writeId: current.writeId } : {}),
      };
    }
    return {
      status: "found",
      draft: {
        revision: current.revision,
        writeId: current.writeId,
        text: current.text,
        ...(current.mentions?.length ? { mentions: current.mentions } : {}),
        ...(current.goalMode ? { goalMode: current.goalMode } : {}),
        ...(current.replyTarget ? { replyTarget: current.replyTarget } : {}),
        ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
        attachments: current.attachments,
        ...(current.questionDrafts?.length ? { questionDrafts: current.questionDrafts } : {}),
      },
    };
  });
}

/** An empty owner has no migration work and need not evaluate the recovery engine. */
export async function prepareDurableComposerRecovery(
  owner: Pick<DurableComposerDraftScope, "gatewayOwner" | "recoveryScope">,
): ReturnType<
  typeof import("./composer-draft-recovery.runtime.ts").prepareDurableComposerRecovery
> {
  try {
    const database = await openDraftDatabase();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const [key] = await Promise.all([
      requestResult(transaction.objectStore(STORE_NAME).index(OWNER_INDEX).getKey(ownerKey(owner))),
      completed,
    ]);
    if (key === undefined) {
      return { status: "ready", entries: [] };
    }
    // The migration opens its own write transaction and rereads authoritative rows.
    const runtime = await import("./composer-draft-recovery.runtime.ts");
    return runtime.prepareDurableComposerRecovery(owner);
  } catch {
    return { status: "storage-failed" };
  }
}

export async function discardDurableComposerRecovery(
  ...args: Parameters<
    typeof import("./composer-draft-recovery.runtime.ts").discardDurableComposerRecovery
  >
): ReturnType<
  typeof import("./composer-draft-recovery.runtime.ts").discardDurableComposerRecovery
> {
  try {
    const runtime = await import("./composer-draft-recovery.runtime.ts");
    return runtime.discardDurableComposerRecovery(...args);
  } catch {
    return { status: "storage-failed" };
  }
}

export async function restoreDurableComposerRecovery(
  ...args: Parameters<
    typeof import("./composer-draft-recovery.runtime.ts").restoreDurableComposerRecovery
  >
): ReturnType<
  typeof import("./composer-draft-recovery.runtime.ts").restoreDurableComposerRecovery
> {
  try {
    const runtime = await import("./composer-draft-recovery.runtime.ts");
    return runtime.restoreDurableComposerRecovery(...args);
  } catch {
    return { status: "storage-failed" };
  }
}

export async function writeDurableComposerDraft(
  ...args: Parameters<typeof import("./composer-draft-write.runtime.ts").writeDurableComposerDraft>
): ReturnType<typeof import("./composer-draft-write.runtime.ts").writeDurableComposerDraft> {
  try {
    const runtime = await import("./composer-draft-write.runtime.ts");
    return runtime.writeDurableComposerDraft(...args);
  } catch {
    return { status: "storage-failed" };
  }
}

export async function retireDurableComposerDraft(
  ...args: Parameters<typeof import("./composer-draft-write.runtime.ts").retireDurableComposerDraft>
): ReturnType<typeof import("./composer-draft-write.runtime.ts").retireDurableComposerDraft> {
  try {
    const runtime = await import("./composer-draft-write.runtime.ts");
    return runtime.retireDurableComposerDraft(...args);
  } catch {
    return { status: "storage-failed" };
  }
}

export async function retireDurableComposerDrafts(
  ...args: Parameters<
    typeof import("./composer-draft-write.runtime.ts").retireDurableComposerDrafts
  >
): ReturnType<typeof import("./composer-draft-write.runtime.ts").retireDurableComposerDrafts> {
  try {
    const runtime = await import("./composer-draft-write.runtime.ts");
    return runtime.retireDurableComposerDrafts(...args);
  } catch {
    return "storage-failed";
  }
}
