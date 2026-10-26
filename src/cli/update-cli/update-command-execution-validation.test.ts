// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as diskSpace from "../../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { assessInitialUpdateSnapshotCapacity } from "../../infra/update-candidate-snapshot.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import { recordUpdateRunStepAsync } from "../../infra/update-run-write.async.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { UpdateCommandOptions } from "./shared.js";
import { preflightBackup } from "./update-command-database-backup.js";
import { registerExecutionPhaseReceiptTests } from "./update-command-execution-phase.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { admitSourceUpdateArtifacts } from "./update-command-git-admission.js";
import { updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import * as readiness from "./update-command-readiness.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

const {
  bindExecutionGuards,
  executionParams,
  mocks,
  packageCandidate,
  readyCanary,
  successfulUpdate,
} = await import("./update-command-execution.test-support.js");

const phaseAdmission = vi.hoisted(() => ({ active: false }));
const execute = async (params = executionParams("git")) =>
  executeMutableUpdate(await bindExecutionGuards(params));
function gitCandidate(onValidated: (steps: unknown) => void = () => {}, gitMode = false) {
  mocks.runGitUpdate.mockImplementation(
    async ({
      validateCandidate,
    }: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
      expect(validateCandidate).toBeTypeOf("function");
      onValidated(await validateCandidate!("/candidate"));
      return gitMode ? { ...successfulUpdate, mode: "git" } : successfulUpdate;
    },
  );
}
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      const [admit, attachment] = args;
      return actual.createSqliteWorkerOperationAdmission((request, grant) => {
        phaseAdmission.active = true;
        try {
          admit(request, grant);
        } finally {
          phaseAdmission.active = false;
        }
      }, attachment);
    },
  };
});

registerExecutionPhaseReceiptTests({ executionParams, mocks, successfulUpdate, phaseAdmission });
it.each([
  { owner: "dead", changed: false },
  { owner: "absent", changed: false },
  { owner: "absent", changed: true },
])(
  "admits installed artifacts before Git mutation (owner=$owner, changed=$changed)",
  async ({ owner, changed }) =>
    withTestDir({ prefix: "source-artifact-admission-" }, async (root) => {
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, "scripts"));
      await fs.writeFile(
        path.join(root, "scripts", "stage-bundled-plugin-runtime.mts"),
        `import fs from "node:fs";
import path from "node:path";
export function prepareBundledPluginRuntime({ repoRoot }) {
  const stage = path.join(repoRoot, ".artifacts", "admission-stage");
  fs.mkdirSync(stage);
  return {
    changed: ${changed},
    publish: async () => { throw new Error("Admission must not publish runtime"); },
    cleanup: async () => fs.rmSync(stage, { recursive: true }),
  };
}
`,
      );
      const lock = path.join(root, ".artifacts", "dist-artifacts.lock");
      const ownerFile = path.join(lock, "owner.json");
      const pid = 0x7fff_ffff;
      const ownerRecord = JSON.stringify({
        pid,
        startedAt: "2026-09-20T01:00:00.000Z",
        startIdentity: "fixture-build-owner",
        heartbeatAt: "2026-09-20T01:01:00.000Z",
      });
      if (owner !== "absent") {
        await fs.mkdir(lock, { recursive: true });
        await fs.writeFile(ownerFile, ownerRecord);
      }
      const onActivation = vi.fn();
      const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const execution = await withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        const result = await execute({
          ...executionParams("git"),
          root,
          opts: { json: true, run },
          onActivation,
        });
        if (owner === "absent") {
          await expect(admitSourceUpdateArtifacts(root, run)).rejects.toThrow(
            `retained by PID ${process.pid}`,
          );
        }
        return result;
      });

      expect(mocks.serviceStopped).toBe(false);
      expect(
        mocks.maybeStopService.mock.calls.every(([params]) => params.phase === "inspect"),
      ).toBe(true);
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(onActivation).not.toHaveBeenCalled();
      expect(execution?.mutationStarted).toBe(false);
      if (owner !== "absent") {
        expect(mocks.runGitUpdate).not.toHaveBeenCalled();
        expect(execution?.result).toMatchObject({
          status: "error",
          reason: "source-artifact-ownership",
        });
        expect(execution?.failure?.detail).toContain(lock);
        expect(execution?.failure?.detail).toContain(`retained by PID ${pid}`);
        expect(execution?.failure?.detail).toContain("to release and retry");
        expect(await fs.readFile(ownerFile, "utf8")).toBe(ownerRecord);
      } else {
        expect(execution?.result.status, execution?.failure?.detail).toBe("ok");
        expect(mocks.runGitUpdate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sourceRuntimePrepared: !changed }),
        );
        await expect(fs.stat(ownerFile)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.stat(path.join(root, ".artifacts", "admission-stage"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    }),
);

it.each(["measurement", "reporting"] as const)(
  "does not turn authority loss during capacity %s into a warning",
  (boundary) =>
    withTestDir({ prefix: "activation-capacity-authority-" }, async (root) => {
      const stale = new Error("fixture executor was replaced during measurement");
      const execution = await bindExecutionGuards(executionParams("git"));
      let current = boundary !== "measurement";
      execution.executionGuards.assertCurrent = () => {
        if (!current) {
          throw stale;
        }
      };
      execution.progress = {
        onStepComplete: async () => {
          current = false;
        },
      };
      await expect(
        preflightBackup(execution, path.join(root, "backup"), {
          config: {},
          env: { OPENCLAW_STATE_DIR: root },
        }),
      ).rejects.toBe(stale);
    }),
);

it("continues the update with its recorded readiness warning", async () => {
  const message =
    "Readiness probe http://127.0.0.1:18789/readyz failed: HTTP 502. Check the configured proxy.";
  const step = updateStep("candidate-gateway-startup", {
    command: "gateway run",
    cwd: "/candidate",
    durationMs: 308_123,
    exitCode: null,
    advisory: { kind: "candidate-runtime-unavailable", message },
    failureFacts: [{ check: "readyz", code: "candidate-readiness-probe-failed", message }],
  });
  mocks.validateCanary.mockImplementation(async ({ onStep }) => {
    await onStep(step);
    return readyCanary([step], step.durationMs, [message]);
  });
  gitCandidate();
  const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

  const execution = await execute({ ...executionParams("git"), progress: { onStepComplete } });

  expect(execution?.result.status).toBe("ok");
  expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
  const recorded = onStepComplete.mock.calls.flatMap(([completed]) =>
    updateRunStepsFromResultStep(completed),
  );
  expect(updateRunWarningMessages(recorded)).toEqual([message]);
  expect(recorded.every((entry) => entry.status === "completed")).toBe(true);
});

it("reports the post-stop activation checks as a timed step", async () => {
  // Gateway readiness is outside this timed-step contract.
  vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockResolvedValue(true);
  mocks.runPackageUpdate.mockImplementation(packageCandidate("/candidate"));
  const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

  const execution = await execute({
    ...executionParams("package"),
    shouldRestart: false,
    progress: { onStepComplete },
  });

  expect(execution?.result.status).toBe("ok");
  const step = execution?.result.steps.find((entry) => entry.name === "post-stop-checks");
  expect(step).toMatchObject({ exitCode: 0, durationMs: expect.any(Number) });
  expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining({ ...step }));
});

it("retains rejected Git canary findings in the terminal result", async () => {
  const fact = {
    check: "core/doctor/config-readable",
    code: "doctor-failed",
    message: "The configured state directory is not readable.",
    affectedKey: "stateDir",
  };
  mocks.validateCanary.mockResolvedValue({
    status: "error",
    reason: "doctor-failed",
    phase: "doctor",
    durationMs: 1,
    logTail: [fact.message],
    steps: [
      updateStep("candidate-doctor", {
        command: "openclaw doctor",
        cwd: "/candidate",
        exitCode: 1,
        stderrTail: fact.message,
        failureFacts: [fact],
      }),
    ],
  });
  gitCandidate(undefined, true);

  const execution = await execute();

  expect(execution?.result).toMatchObject({
    status: "error",
    reason: "doctor-failed",
    steps: [{ failureFacts: [fact] }],
  });
  expect(mocks.serviceStopped).toBe(false);
});

it.each([
  { kind: "git", space: 110 },
  { kind: "package", space: 110 },
  { kind: "package", space: 200 },
  { kind: "package", space: null },
] as const)(
  "checks the $kind activation destination after staging ($space MiB free)",
  async ({ kind, space }) =>
    withTestDir({ prefix: "activation-backup-capacity-" }, async (root) => {
      const stateDir = path.join(root, "state");
      const database = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(path.dirname(database), { recursive: true });
      await fs.writeFile(configPath, "{}");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.10.6" }),
      );
      {
        using db = openNodeSqliteDatabase(database);
        db.exec("CREATE TABLE evidence(value TEXT)");
      }
      // The capacity owner reads family lengths; no payload allocation is needed.
      await fs.truncate(database, 16 * 1024 ** 2);
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const control = path.join(root, "coordinator");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const context = {
        env,
        readEnv: env,
        config: {},
        configSnapshot: createTestConfigSnapshot({}, {}, configPath),
      };
      mocks.captureManagedPreflight.mockResolvedValue(context);
      mocks.captureSchemaContext.mockResolvedValue(context);
      mocks.nativeSupport.mockResolvedValue(true);
      mocks.maybeStopService.mockImplementation(async ({ phase }) => ({
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: phase === "prepare",
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned",
          root,
          fingerprint: "fixture-service",
          refreshDefinition: false,
        },
      }));
      vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockResolvedValue(true);
      const backupRoot = path.join(root, "package-backup");
      const destination = kind === "git" ? path.join(root, ".artifacts") : backupRoot;
      let availableMiB: number | null = 200;
      vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
        const free = targetPath === destination ? availableMiB : 200;
        return free === null
          ? null
          : {
              targetPath,
              checkedPath: root,
              availableBytes: free * 1024 ** 2,
              totalBytes: 1024 ** 3,
            };
      });
      expect(
        await assessInitialUpdateSnapshotCapacity({
          config: {},
          env,
          stateDir,
          backupDirectory: destination,
        }),
      ).toMatchObject({ exitCode: 0 });
      mocks.validateCanary.mockImplementation(async () => {
        // Only the exact activation destination changes; other volumes still have room.
        availableMiB = space;
        return readyCanary([]);
      });
      const publish = vi.fn();
      mocks.runPackageUpdate.mockImplementation(async (options) => {
        await options.validateCandidate(root);
        await options.beforeActivate(backupRoot);
        publish();
        return { ...successfulUpdate, root };
      });
      mocks.runGitUpdate.mockImplementation(async (options) => {
        const target = { sha: "a".repeat(40), version: "2026.10.6" };
        await options.inspectGitTarget(target);
        await options.validateCandidate(root);
        await options.beforeGitMutation(target, path.join(root, ".artifacts"));
        publish();
        return { ...successfulUpdate, mode: "git", root };
      });
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
      };
      const before = await fs.readFile(database);
      try {
        await recordUpdateRunStepAsync(
          run.runId,
          { step: "fixture-warm", status: "completed" },
          { env },
        );
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            admitExecutor(await executor.enter(root));
          });
          const execution = await executeMutableUpdate(
            await bindExecutionGuards({
              ...executionParams(kind),
              root,
              opts: { json: true, run },
            }),
          );
          const refused = space === 110;
          expect(execution?.result, execution?.failure?.detail).toMatchObject({
            status: refused ? "error" : "ok",
          });
          expect(execution?.mutationStarted).toBe(!refused);
          expect(publish).toHaveBeenCalledTimes(refused ? 0 : 1);
          const preparation = mocks.maybeStopService.mock.calls.filter(
            ([options]) => options.phase === "prepare",
          );
          expect(preparation).toHaveLength(refused ? 0 : 1);
          const measured = execution?.result.steps.find(
            (step) => step.name === "activation-backup-space-preflight",
          );
          if (refused) {
            expect(execution?.failure?.detail).toContain("Update database backup");
            expect(execution?.failure?.detail).toContain(destination);
            expect(measured).toMatchObject({
              exitCode: 1,
              stderrTail: expect.stringContaining(destination),
            });
          } else if (space === null) {
            expect(measured?.warnings).toContain(
              `Available disk space could not be measured near ${destination}; database backup will be attempted.`,
            );
          } else {
            expect(measured?.diagnostics?.join("\n")).toContain(destination);
          }
        });
      } finally {
        await run.sourceArtifactLock?.release();
        await closeStateDatabaseForTest();
      }
      expect((await fs.readFile(database)).equals(before)).toBe(true);
    }),
);
