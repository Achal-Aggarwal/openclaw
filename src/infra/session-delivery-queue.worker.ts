import { isDeepStrictEqual } from "node:util";
import { computeBackoff } from "../../packages/retry/src/index.js";
import {
  decodeSubagentCompletionRecord,
  mutateSubagentCompletionInDatabase,
} from "../agents/subagents/completion/subagent-completion-mutation.kernel.js";
import type {
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
  SubagentCompletionRecord,
} from "../agents/subagents/completion/subagent-completion-mutation.types.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { readSubagentRunRow } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  isSubagentRunGenerationCandidate,
} from "../agents/subagents/registry/subagent-run-generation.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  type DeliveryQueueStoredStatus,
} from "./delivery-queue-sqlite.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryAgentRunUpdate } from "./session-delivery-queue.worker-contract.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const query = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, "subagent_runs">>(db);

function commitCompletionWrite<T extends object>(
  input: { writeId: string },
  database: OpenClawStateDatabase,
  operationLabel: string,
  mutate: () => T,
): T & { writeId: string } {
  const { writeId } = input;
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
      const receipt = { writeId, ...mutate() };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
      deferSqliteWorkerCommitReceipt(database.db, receipt);
      return receipt;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel },
  );
}

function readSessionDelivery(
  database: OpenClawStateDatabase,
  id: string,
): QueuedSessionDelivery | null {
  const entry = loadDeliveryQueueEntryInDatabase(
    database,
    SESSION_DELIVERY_QUEUE_NAME,
    id,
    "pending",
  );
  // SAFETY: The session namespace retains the canonical session-delivery payload contract.
  return entry as QueuedSessionDelivery | null;
}

function readStatus(database: OpenClawStateDatabase, id: string) {
  return getDeliveryQueueEntryOwnersInDatabase(database, [SESSION_DELIVERY_QUEUE_NAME], id).get(
    SESSION_DELIVERY_QUEUE_NAME,
  )?.status;
}

function update(
  database: OpenClawStateDatabase,
  id: string,
  transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery,
) {
  return updateDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id, (entry) =>
    // SAFETY: Only the session namespace reaches this payload transform.
    transform(entry as QueuedSessionDelivery),
  );
}

function finalize(
  database: OpenClawStateDatabase,
  id: string,
  status: "completed" | "failed",
  transition: () => void,
) {
  try {
    transition();
  } catch (error) {
    try {
      if (readStatus(database, id) === status) {
        return;
      }
    } catch {
      // Preserve the transition failure when durable settlement cannot be established.
    }
    throw error;
  }
}

type PreparedEntry = ReturnType<typeof bindDeliveryQueueEntry>;
type PreparedMediaResult =
  | { source: "input" }
  | { source: "stored"; blocks: Array<Record<string, unknown>> };

export const sessionDeliveryOperations = {
  "sessionDelivery.mutateSubagentCompletion": (
    input: {
      writeId: string;
      mutation: SubagentCompletionMutation;
    },
    { open },
  ): SubagentCompletionMutationResult & { writeId: string } => {
    const database = open();
    return commitCompletionWrite(
      input,
      database,
      "subagent completion " + input.mutation.kind,
      () => mutateSubagentCompletionInDatabase(database, input.mutation),
    );
  },
  /** The shared-state worker owns queue insertion and its exact native completion owner. */
  "sessionDelivery.admitSubagentCompletion": (
    input: {
      writeId: string;
      queueEntry: QueuedSessionDelivery;
      expected: SubagentRunRecord;
      subagent: SubagentRunRecord;
    },
    { open },
  ): {
    writeId: string;
    claimed: boolean;
    status: DeliveryQueueStoredStatus;
    record: SubagentCompletionRecord;
  } => {
    const database = open();
    const { expected, subagent, queueEntry } = input;
    const owner = queueEntry.kind === "agentTurn" ? queueEntry.owner : undefined;
    const delivery = subagent.delivery;
    if (
      !owner ||
      owner.kind !== "subagent_completion" ||
      owner.runId !== subagent.runId ||
      subagent.runId !== expected.runId ||
      owner.generation !== delivery?.generation ||
      owner.deadlineAt !== delivery.deadlineAt ||
      queueEntry.id !== delivery.queueId
    ) {
      throw new Error("subagent completion admission records do not share one owner generation");
    }
    const boundQueue = bindDeliveryQueueEntry({
      queueName: SESSION_DELIVERY_QUEUE_NAME,
      entry: queueEntry,
      insertOnly: true,
    });
    const boundSubagent = bindSubagentRunRecord(subagent);
    return commitCompletionWrite(input, database, "subagent completion delivery admission", () => {
      const originalRow = readSubagentRunRow(database, expected.runId);
      const current = originalRow && rowToSubagentRunRecord(originalRow);
      if (
        !originalRow ||
        !current ||
        compareSubagentRunGeneration(current, expected) !== 0 ||
        current.childSessionKey !== expected.childSessionKey ||
        current.requesterSessionKey !== expected.requesterSessionKey ||
        current.requesterStorePath !== expected.requesterStorePath
      ) {
        throw new Error("subagent completion owner changed before admission");
      }
      const siblings = executeSqliteQuerySync(
        database.db,
        query(database.db)
          .selectFrom("subagent_runs")
          .selectAll()
          .where("child_session_key", "=", expected.childSessionKey),
      ).rows;
      for (const row of siblings) {
        const candidate = rowToSubagentRunRecord(row);
        if (
          !candidate ||
          (isSubagentRunGenerationCandidate(
            candidate,
            expected.childSessionKey,
            expected.childAgentId,
          ) &&
            compareSubagentRunGeneration(candidate, expected) > 0)
        ) {
          throw new Error("subagent completion owner was replaced before admission");
        }
      }
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      const status = claimed
        ? "pending"
        : (getDeliveryQueueEntryOwnersInDatabase(
            database,
            [SESSION_DELIVERY_QUEUE_NAME],
            queueEntry.id,
          ).get(SESSION_DELIVERY_QUEUE_NAME)?.status ?? "pending");
      if (claimed) {
        writeSubagentRunValuesInDatabase(database, [boundSubagent], []);
      } else {
        // The namespace owns this payload; a duplicate may acknowledge only its original generation.
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          queueEntry.id,
          // SAFETY: The exact session queue namespace is written only with its typed delivery payload.
        ) as QueuedSessionDelivery | null;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (
          !existingOwner ||
          existingOwner.kind !== owner.kind ||
          existingOwner.runId !== owner.runId ||
          existingOwner.taskId !== owner.taskId ||
          existingOwner.generation !== owner.generation ||
          existingOwner.deadlineAt !== owner.deadlineAt ||
          existing?.sessionKey !== queueEntry.sessionKey ||
          (existing.kind === "agentTurn" &&
            queueEntry.kind === "agentTurn" &&
            !isDeepStrictEqual(existing.requesterBinding, queueEntry.requesterBinding)) ||
          (current.delivery?.generation ?? 1) !== owner.generation ||
          (status === "pending" &&
            (current.delivery?.queueId !== queueEntry.id ||
              current.delivery.deadlineAt !== owner.deadlineAt))
        ) {
          throw new Error(`session delivery queue conflict for ${queueEntry.id}`);
        }
      }
      return {
        claimed,
        status,
        record: decodeSubagentCompletionRecord(claimed ? boundSubagent : originalRow),
      };
    });
  },
  "sessionDelivery.enqueue": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        upsertBoundDeliveryQueueEntryInDatabase(input, database);
      },
      { operationLabel: "sessionDelivery.enqueue" },
    ),
  "sessionDelivery.enqueueClaimed": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        const id = input.row.id;
        const claimed = upsertBoundDeliveryQueueEntryInDatabase(input, database);
        let status: DeliveryQueueStoredStatus;
        try {
          status = claimed ? "pending" : (readStatus(database, id) ?? "completed");
        } catch {
          status = "unknown";
        }
        return { id, claimed, status };
      },
      { operationLabel: "sessionDelivery.enqueueClaimed" },
    ),
  "sessionDelivery.releaseClaim": (input: { id: string }, { open }) => {
    const database = open();
    update(database, input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
  },
  "sessionDelivery.defer": (input: { id: string; delayMs: number }, { open }) => {
    const database = open();
    const { id, delayMs } = input;
    update(database, id, (entry) => ({
      ...entry,
      availableAt: Date.now() + Math.max(0, delayMs),
    }));
  },
  "sessionDelivery.advanceAgentRun": (
    input: { id: string; updates?: SessionDeliveryAgentRunUpdate },
    { open },
  ) => {
    const database = open();
    const { id, updates } = input;
    update(database, id, (entry) =>
      entry.kind !== "agentTurn"
        ? entry
        : {
            ...entry,
            agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
            deliveryStartedAt: undefined,
            ...(updates?.message ? { message: updates.message } : {}),
            ...(updates?.expectedMediaUrls ? { expectedMediaUrls: updates.expectedMediaUrls } : {}),
          },
    );
  },
  "sessionDelivery.mergePreparedMedia": (
    input: { id: string; mediaUrl: string; blocksJson: string },
    { open },
  ): PreparedMediaResult => {
    const database = open();
    const { id, mediaUrl, blocksJson } = input;
    let result: PreparedMediaResult = {
      source: "input",
    };
    update(database, id, (entry) => {
      if (entry.kind !== "agentTurn") {
        return entry;
      }
      const stored = entry.preparedMediaBlocks?.[mediaUrl];
      // SAFETY: The host serialized the caller's typed block array before worker admission.
      const blocks = stored ?? (JSON.parse(blocksJson) as Array<Record<string, unknown>>);
      if (stored != null) {
        result = { source: "stored", blocks: stored };
      }
      return {
        ...entry,
        preparedMediaBlocks: { ...entry.preparedMediaBlocks, [mediaUrl]: blocks },
      };
    });
    return result;
  },
  "sessionDelivery.markAttemptStarted": (input: PreparedEntry, { open }) => {
    const database = open();
    if (!upsertBoundDeliveryQueueEntryInDatabase(input, database)) {
      throw new Error(`Session delivery ${input.row.id} is no longer pending`);
    }
  },
  "sessionDelivery.markSettlement": (input: PreparedEntry, { open }) => {
    const database = open();
    const id = input.row.id;
    return finalize(database, id, "completed", () => {
      if (
        upsertBoundDeliveryQueueEntryInDatabase(input, database) ||
        readStatus(database, id) === "completed"
      ) {
        return;
      }
      throw new Error(`Session delivery ${id} is no longer pending`);
    });
  },
  "sessionDelivery.complete": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "completed", () => {
      completeDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id);
    });
  },
  "sessionDelivery.fail": (
    input: { id: string; error: string; releaseAttemptOwnership?: boolean },
    { open },
  ) => {
    const database = open();
    const { id, error, releaseAttemptOwnership } = input;
    update(database, id, (entry) => {
      const retryCount = entry.retryCount + 1;
      const now = Date.now();
      return {
        ...entry,
        retryCount,
        ...(entry.kind === "agentTurn"
          ? { lastChargedAgentRunAttempt: entry.agentRunAttempt ?? 0 }
          : {}),
        ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
        lastAttemptAt: now,
        ...(entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
          ? {
              availableAt:
                now +
                computeBackoff(
                  { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                  retryCount,
                ),
            }
          : {}),
        lastError: error,
      };
    });
  },
  "sessionDelivery.load": (input: { id: string }, { open }) =>
    readSessionDelivery(open(), input.id),
  "sessionDelivery.list": (_input: undefined, { open }) => {
    const database = open();
    const entries = loadDeliveryQueueEntriesInDatabase(database, SESSION_DELIVERY_QUEUE_NAME);
    // SAFETY: All returned rows belong to the canonical session-delivery namespace.
    return entries as QueuedSessionDelivery[];
  },
  "sessionDelivery.moveToFailed": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "failed", () => {
      const entry = readSessionDelivery(database, id);
      if (!entry) {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
      const result = terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({ queueName: SESSION_DELIVERY_QUEUE_NAME, id, entry }),
      );
      if (result.status !== "terminalized") {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
    });
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations>;
