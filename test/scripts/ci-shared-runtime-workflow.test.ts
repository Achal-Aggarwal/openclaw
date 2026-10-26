import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CHECKOUT_V6,
  DOWNLOAD_ARTIFACT_V8,
  UPLOAD_ARTIFACT_V7,
  evaluateWorkflowCondition,
  readWorkflow,
  requiredWorkflowStep,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

type Job = {
  if: string;
  needs?: string[];
  "runs-on": string;
  "timeout-minutes": number;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast": boolean; "max-parallel": number; matrix: string };
  steps: WorkflowStep[];
};
const workflow: {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  env: Record<string, string>;
  jobs: Record<"plan" | "control" | "producer" | "shared" | "report", Job>;
} = readWorkflow(".github/workflows/ci-shared-runtime-pilot.yml");
const { control, producer, shared, report } = workflow.jobs;
const temps = useAutoCleanupTempDirTracker(afterEach);
const step = (job: Job, name: string) => requiredWorkflowStep(job.steps, name);

function runInline(job: Job, name: string, cwd: string, env: NodeJS.ProcessEnv) {
  const body = step(job, name).run?.match(/<<'JS'\n([\s\S]*?)\nJS\n?$/u)?.[1];
  if (!body) {
    throw new Error("Missing executable inline module: " + name);
  }
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: body,
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("manual shared-runtime qualification", () => {
  it("cannot trigger automatically, execute fork code, or acquire write permission", () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ci-shared-runtime-pilot",
      "cancel-in-progress": false,
    });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      expect(job["timeout-minutes"]).toBe(60);
      for (const [repository, eventName, allowed] of [
        ["openclaw/openclaw", "workflow_dispatch", true],
        ["someone/fork", "workflow_dispatch", false],
        ["openclaw/openclaw", "pull_request", false],
        ["openclaw/openclaw", "push", false],
      ] as const) {
        expect(evaluateWorkflowCondition(job.if, { repository, eventName, runAttempt: 1 })).toBe(
          allowed,
        );
      }
      const checkout = step(job, "Checkout exact workflow source");
      expect(checkout).toMatchObject({
        uses: CHECKOUT_V6,
        with: { ref: "${{ github.sha }}", "persist-credentials": false },
      });
      expect(checkout.with?.repository).toBeUndefined();
      expect(step(job, "Setup Node environment")).toMatchObject({
        uses: "./.github/actions/setup-node-env",
        with: { "cache-mode": "off", "frozen-lockfile": "true", "install-bun": "false" },
      });
    }
  });

  it("compares identical planner rows and execution commands with only preparation shared", () => {
    expect(control.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": 2,
      matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}",
    });
    expect(shared.strategy).toEqual(control.strategy);
    expect(shared.needs).toEqual(["plan", "producer"]);
    expect(control.needs).toEqual(["plan"]);
    expect(step(control, "Run unchanged Node worker shard")).toEqual(
      step(shared, "Run unchanged Node worker shard"),
    );
    expect(workflow.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      VITEST: "1",
      OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
      OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
      OPENCLAW_VITEST_MAX_WORKERS: "2",
      OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000",
    });
    for (const [job, name] of [
      [control, "Build independent private QA runtime"],
      [producer, "Build shared private QA runtime once"],
    ] as const) {
      expect(step(job, name).run).toMatch(/ -- pnpm build qaRuntime$/u);
    }
    expect(shared.steps.some((owner) => owner.run?.includes("pnpm build"))).toBe(false);
    expect(shared.steps.indexOf(step(shared, "Verify and restore shared runtime"))).toBeLessThan(
      shared.steps.indexOf(step(shared, "Run unchanged Node worker shard")),
    );
  });

  it("downloads only the exact same-run producer artifact and retains attempt-scoped receipts", () => {
    expect(producer.outputs).toEqual({
      "artifact-id": "${{ steps.runtime-upload.outputs.artifact-id }}",
    });
    expect(step(shared, "Download exact producer artifact")).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: { "artifact-ids": "${{ needs.producer.outputs.artifact-id }}" },
    });
    for (const job of [control, producer, shared]) {
      expect(job.steps[0]?.name).toBe("Start job clock");
      expect(step(job, "Record job receipt").if).toBe("always()");
      const upload = step(job, "Upload job receipts");
      expect(upload).toMatchObject({
        if: "always()",
        uses: UPLOAD_ARTIFACT_V7,
        with: { "compression-level": 0, "retention-days": 1, "if-no-files-found": "error" },
      });
      expect(upload.with?.name).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    }
    expect(step(producer, "Upload same-run runtime")).toMatchObject({
      uses: UPLOAD_ARTIFACT_V7,
      with: { "compression-level": 0, "retention-days": 1, "if-no-files-found": "error" },
    });
    expect(report.needs).toEqual(["plan", "control", "producer", "shared"]);
    expect(step(report, "Download this attempt's receipts").with).toEqual({
      pattern: "shared-runtime-receipts-*-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".artifacts/shared-runtime-pilot/receipts",
      "merge-multiple": true,
    });
  });

  it("records setup, transfer, source and failure status and refuses incomplete comparisons", () => {
    const root = temps.make("shared-runtime-workflow-");
    const receipts = path.join(root, ".artifacts/shared-runtime-pilot/receipts");
    const runtime = path.join(root, ".artifacts/shared-runtime-pilot/runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, "runtime.tgz"), "synthetic runtime bytes");
    const env = {
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "2",
      PILOT_JOB_STARTED_MS: "1000",
      PILOT_SETUP_FINISHED_MS: "1300",
      PILOT_TRANSFER_STARTED_MS: "1400",
      PILOT_TRANSFER_FINISHED_MS: "1600",
      PILOT_JOB_STATUS: "success",
    };
    const rows = [{ check_name: "worker-one" }, { check_name: "worker-two" }];
    const owners = [
      ["producer", "runtime"],
      ...["control", "shared"].flatMap((arm) => rows.map((row) => [arm, row.check_name])),
    ];
    for (const [arm, name] of owners) {
      const result = runInline(control, "Record job receipt", root, {
        ...env,
        PILOT_ARM: arm,
        PILOT_CHECK_NAME: name,
      });
      expect(result.status, result.stderr).toBe(0);
      const phases =
        arm === "producer"
          ? ["build", "pack"]
          : arm === "control"
            ? ["build", "test"]
            : ["restore", "test"];
      for (const phase of phases) {
        writeFileSync(
          path.join(receipts, arm + "-" + name + "-" + phase + ".json"),
          JSON.stringify({ revision: env.GITHUB_SHA, runId: "42", attempt: "2", exitCode: 0 }),
        );
      }
    }
    const readJob = (name: string) => JSON.parse(readFileSync(path.join(receipts, name), "utf8"));
    expect(readJob("producer-runtime-job.json")).toMatchObject({
      kind: "job",
      status: "success",
      revision: env.GITHUB_SHA,
      setupElapsedMs: 300,
      transferElapsedMs: 200,
      artifactBytes: 23,
    });
    const needs = Object.fromEntries(
      ["plan", "control", "producer", "shared"].map((name) => [name, { result: "success" }]),
    );
    const check = (jobResults = needs) =>
      runInline(report, "Require all experiment arms", root, {
        ...env,
        PILOT_MATRIX_JSON: JSON.stringify({ include: rows }),
        PILOT_NEEDS_JSON: JSON.stringify(jobResults),
      });
    expect(check().status).toBe(0);
    const phaseFile = path.join(receipts, "control-worker-one-test.json");
    const phaseReceipt = readFileSync(phaseFile, "utf8");
    rmSync(phaseFile);
    expect(check().status).not.toBe(0);
    writeFileSync(phaseFile, JSON.stringify({ ...JSON.parse(phaseReceipt), exitCode: 1 }));
    expect(check().status).not.toBe(0);
    writeFileSync(phaseFile, phaseReceipt);
    expect(check({ ...needs, shared: { result: "failure" } }).status).not.toBe(0);
    const failed = runInline(control, "Record job receipt", root, {
      ...env,
      PILOT_ARM: "shared",
      PILOT_CHECK_NAME: "worker-one",
      PILOT_JOB_STATUS: "failure",
    });
    expect(failed.status, failed.stderr).toBe(0);
    expect(check().status).not.toBe(0);
    rmSync(path.join(receipts, "shared-worker-one-job.json"));
    expect(check().status).not.toBe(0);
  });
});
