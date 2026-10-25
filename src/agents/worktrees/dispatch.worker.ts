import { hasLocalWorkspaceProjectionInDatabase } from "../../gateway/worker-environments/local-workspace-store.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  reservePendingWorktreeInDatabase,
  releasePendingWorktreeInDatabase,
} from "./pending-slots.worker.js";
import { writeProvisionedSnapshotInDatabase } from "./provisioned-snapshot.worker.js";
import {
  withWorktreeRegistryWorkerReceipt,
  worktreeRegistryPublication,
} from "./registry-publication.js";
import {
  getRegistryWorktreeInDatabase,
  rowToRecord,
  worktreeGcRevision,
} from "./registry-read.kernel.js";
import {
  worktreeRunEndMutation,
  claimWorktreeRemovalInDatabase,
  finalizeWorktreeRemovalInDatabase,
  abortWorktreeRemovalInDatabase,
  insertRegistryWorktreeInDatabase,
  updateRegistryWorktreeInDatabase,
  deleteRegistryWorktreeInDatabase,
  assertWorktreeRegistryPredicates,
} from "./registry-run-end.worker.js";
import { reapWorktreeRunLeasesInDatabase } from "./run-lease-owner.js";
import {
  admitWorktreeRunLeaseInDatabase,
  releaseWorktreeRunLeaseInDatabase,
  type WorktreeRunLeaseRowInput,
} from "./run-lease-store.kernel.js";
import type {
  WorktreeRegistryPredicate,
  ManagedWorktreeRecord,
  WorktreeRemovalDeferral,
} from "./types.js";

export const worktreeOperations = {
  "worktrees.assertPredicates": (
    { predicates }: { predicates: readonly WorktreeRegistryPredicate[] },
    { open },
  ) => assertWorktreeRegistryPredicates(open().db, predicates),
  "worktrees.delete": worktreeRunEndMutation("worktrees.delete", deleteRegistryWorktreeInDatabase),
  "worktrees.reservePending": worktreeRunEndMutation(
    "worktrees.reservePending",
    reservePendingWorktreeInDatabase,
  ),
  "worktrees.releasePending": worktreeRunEndMutation(
    "worktrees.releasePending",
    releasePendingWorktreeInDatabase,
  ),
  "worktrees.insert": worktreeRunEndMutation("worktrees.insert", insertRegistryWorktreeInDatabase),
  "worktrees.update": worktreeRunEndMutation("worktrees.update", updateRegistryWorktreeInDatabase),
  "worktrees.claimRemoval": worktreeRunEndMutation(
    "worktrees.claimRemoval",
    claimWorktreeRemovalInDatabase,
  ),
  "worktrees.finalizeRemoval": worktreeRunEndMutation(
    "worktrees.finalizeRemoval",
    finalizeWorktreeRemovalInDatabase,
  ),
  "worktrees.abortRemoval": worktreeRunEndMutation(
    "worktrees.abortRemoval",
    abortWorktreeRemovalInDatabase,
  ),
  "worktrees.writeProvisionedSnapshot": worktreeRunEndMutation(
    "worktrees.writeProvisionedSnapshot",
    writeProvisionedSnapshotInDatabase,
  ),
  "worktrees.retireMissing": (
    input: {
      observed: Pick<
        ManagedWorktreeRecord,
        "id" | "path" | "lastActiveAt" | "repoRoot" | "repoFingerprint"
      >;
      removedAt: number;
    },
    { open, stateOptions },
  ): { record?: ManagedWorktreeRecord; protection?: "local-workspace-projection" } => {
    const options = { ...stateOptions(), database: open() };
    const { observed, removedAt } = input;
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          // Projection creation checks the live registry in its own write transaction.
          // Whichever writer commits first fences the other, including unfinished preparation.
          if (hasLocalWorkspaceProjectionInDatabase(db, observed.id)) {
            return {
              record: getRegistryWorktreeInDatabase(db, observed.id),
              protection: "local-workspace-projection",
            };
          }
          // A path probe cannot retire a restored lifecycle or a rebound repository.
          const retired = executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
              .updateTable("worktrees")
              .set({ removed_at: removedAt })
              .where("id", "=", observed.id)
              .where("removed_at", "is", null)
              // A private exact-state retirement path may still hold the complete
              // source. Only its explicit recovery owner can finalize that lifecycle.
              .where((eb) =>
                eb.or([
                  eb("snapshot_ref", "is", null),
                  eb("snapshot_ref", "not like", "refs/openclaw/snapshots/exact-%"),
                ]),
              )
              .where("path", "=", observed.path)
              .where("last_active_at", "=", observed.lastActiveAt)
              .where("repo_root", "=", observed.repoRoot)
              .where("repo_fingerprint", "=", observed.repoFingerprint)
              .returningAll(),
          ).rows[0];
          worktreeRegistryPublication.rows(db, retired ? [retired] : []);
          const record = retired
            ? rowToRecord(retired)
            : getRegistryWorktreeInDatabase(db, observed.id);

          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return { record };
        }),
      options,
      { operationLabel: "worktrees.retireMissing" },
    );
  },
  "worktrees.deferCleanup": (
    input: {
      observed: ManagedWorktreeRecord;
      reason: string | null;
      retry?: WorktreeRemovalDeferral;
      removalToken?: string;
    },
    { open, stateOptions },
  ): boolean => {
    const options = { ...stateOptions(), database: open() };
    const { observed, reason, retry, removalToken } = input;
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          if (removalToken) {
            assertWorktreeRegistryPredicates(db, [
              { kind: "removal-claim", id: observed.id, token: removalToken },
            ]);
          }
          const current = getRegistryWorktreeInDatabase(db, observed.id);
          const revision = worktreeGcRevision(observed);
          if (
            !current ||
            current.removedAt !== undefined ||
            worktreeGcRevision(current) !== revision
          ) {
            return false;
          }
          const rows = executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
              .updateTable("worktrees")
              .set({
                gc_protection_json:
                  reason === null ? null : JSON.stringify({ revision, reason, retry }),
              })
              .where("id", "=", observed.id)
              .returningAll(),
          ).rows;
          worktreeRegistryPublication.rows(db, rows);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return true;
        }),
      options,
      { operationLabel: "worktrees.deferCleanup" },
    );
  },
  "worktrees.admitRunLease": (input: WorktreeRunLeaseRowInput, { writeAdmitted }) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => admitWorktreeRunLeaseInDatabase(db, input)),
      {
        operationLabel: "worktrees.admitRunLease",
      },
    ),
  "worktrees.releaseRunLease": (
    { worktreeId, token }: { worktreeId: string; token: string },
    { writeAdmitted },
  ) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () =>
          releaseWorktreeRunLeaseInDatabase(db, worktreeId, token),
        ),
      {
        operationLabel: "worktrees.releaseRunLease",
      },
    ),
  "worktrees.reapRunLeases": ({ scopes }: { scopes: string[] }, { writeAdmitted }) =>
    writeAdmitted(
      ({ db }) =>
        withWorktreeRegistryWorkerReceipt(db, () => reapWorktreeRunLeasesInDatabase(db, scopes)),
      {
        operationLabel: "worktrees.reapRunLeases",
      },
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type WorktreeWorkerOperations = WorkerOperations<typeof worktreeOperations>;
