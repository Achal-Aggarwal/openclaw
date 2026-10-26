import {
  mergeWorkspaceSetupState,
  type WorkspaceSetupState,
} from "../agents/workspace-state-store.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { readClawInventory } from "./inventory-read.js";
import { readClawPackageRefs } from "./provenance.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";

export type ClawAddStateOptions = ClawMutationStateOptions;

export async function readClawPackageRefsForAdd(
  options: NonNullable<Parameters<typeof readClawPackageRefs>[0]> & ClawAddStateOptions = {},
): Promise<ReturnType<typeof readClawPackageRefs>> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return readClawPackageRefs(options);
  }
  options.assertCurrent?.();
  const { packages: refs } = await readClawInventory(options);
  options.assertCurrent?.();
  return refs.filter(
    (ref) =>
      (options.agentId === undefined || ref.agentId === options.agentId) &&
      (options.kind === undefined || ref.kind === options.kind) &&
      (options.source === undefined || ref.source === options.source) &&
      (options.ref === undefined || ref.ref === options.ref) &&
      (options.version === undefined || ref.version === options.version) &&
      (options.integrity === undefined || ref.integrity === options.integrity) &&
      (options.status === undefined || ref.status === options.status),
  );
}

export async function mergeWorkspaceBootstrapSetupStateForAdd(
  workspaceDir: string,
  bootstrapSeededAt: string,
  nowMs: number,
  options: ClawAddStateOptions = {},
): Promise<WorkspaceSetupState> {
  if (options.stateMode !== "worker") {
    options.assertCurrent?.();
    return mergeWorkspaceSetupState(workspaceDir, { bootstrapSeededAt }, nowMs, options);
  }
  if (options.database) {
    throw new Error("Worker-mode Claw lifecycle cannot use a caller-owned database handle.");
  }
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = options.assertCurrent;
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "claws.add.mergeBootstrapSetupState",
        input: { workspaceDir, bootstrapSeededAt, nowMs },
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Claw lifecycle state writes require transaction admission.");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      }),
    },
  );
}
