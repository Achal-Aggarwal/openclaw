#!/usr/bin/env node
// Manual qualification only: keep the production shard planner and executor authoritative.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createNodeWorkerE2eTestShards } from "./lib/ci-changed-node-test-plan.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mts";

type PilotRow = ReturnType<typeof createPilotPlan>[number];
export type PilotReceipt = {
  label: string;
  revision: string;
  runId: string;
  attempt: string;
  startedAt: number;
  finishedAt: number;
  seconds: number;
  exitCode: number;
};
export function createPilotPlan() {
  const rows = createNodeWorkerE2eTestShards();
  assert.equal(rows.length, 2, "The pilot requires exactly the existing two worker shards");
  assert.ok(rows.every((row) => row.pretestBuildMode === "private-qa"));
  return rows.map((row) => Object.assign(row, { check_name: row.checkName }));
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
export async function measurePilotCommand(
  label: string,
  file: string,
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  assert.ok(command.length > 0, "A measured command is required");
  const startedAt = Date.now();
  const start = performance.now();
  let exitCode = 2;
  try {
    exitCode = await runManagedCommand({
      bin: command[0]!,
      args: command.slice(1),
      env,
      stdio: "inherit",
      requireProcessTreeExit: true,
      waitForCleanupRelease: true,
    });
    return exitCode;
  } finally {
    const receipt: PilotReceipt = {
      label,
      revision: env.GITHUB_SHA ?? "local",
      runId: env.GITHUB_RUN_ID ?? "local",
      attempt: env.GITHUB_RUN_ATTEMPT ?? "1",
      startedAt,
      finishedAt: Date.now(),
      seconds: (performance.now() - start) / 1000,
      exitCode,
    };
    writeJson(file, receipt);
  }
}
export function pilotRowEnvironment(row: PilotRow, env: NodeJS.ProcessEnv) {
  // Use the same target mode, runtime owner and bounded workers as the existing
  // two-worker process shards; only their runtime preparation transport differs.
  return {
    ...env,
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    VITEST: "1",
    OPENCLAW_E2E_USE_PREBUILT_DIST: "1",
    OPENCLAW_VITEST_MAX_WORKERS: "2",
    OPENCLAW_CI_TEST_RUNTIME_POLICY: "node",
    OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(row.targets),
    OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(row.configs),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
    OPENCLAW_VITEST_SHARD_NAME: row.shardName,
    OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "300000",
  };
}
export function summarizePilotReceipts(receipts: PilotReceipt[]) {
  assert.ok(receipts.length > 0, "No qualification receipts were downloaded");
  const identity = receipts[0]!;
  const labels = new Set<string>();
  for (const receipt of receipts) {
    assert.ok(!labels.has(receipt.label), "Duplicate qualification receipt: " + receipt.label);
    labels.add(receipt.label);
    for (const key of ["revision", "runId", "attempt"] as const) {
      assert.equal(receipt[key], identity[key], "Qualification receipt identity mismatch");
    }
    assert.equal(receipt.exitCode, 0, "Qualification failed: " + receipt.label);
    assert.ok(Number.isFinite(receipt.seconds) && receipt.seconds >= 0);
  }
  return receipts.toSorted((a, b) => a.label.localeCompare(b.label));
}
async function main(args: string[]) {
  const [operation, ...rest] = args;
  if (operation === "plan") {
    assert.equal(rest.length, 1);
    const matrix = { include: createPilotPlan() };
    writeJson(rest[0]!, matrix);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "matrix=" + JSON.stringify(matrix) + "\n");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "## Existing worker shards\n\n" +
          matrix.include
            .map((row) => "- " + row.check_name + ": " + (row.targets?.length ?? 0) + " targets")
            .join("\n") +
          "\n",
      );
    }
    console.log(JSON.stringify(matrix));
    return 0;
  }
  if (operation === "measure") {
    const [label, file, separator, ...command] = rest;
    assert.ok(label && file && separator === "--");
    return measurePilotCommand(label, file, command);
  }
  if (operation === "run") {
    assert.equal(rest.length, 2);
    const row: PilotRow = JSON.parse(rest[0]!);
    const expected = createPilotPlan().find((entry) => entry.check_name === row.check_name);
    assert.deepEqual(row, expected, "Only a complete existing worker shard is admitted");
    return measurePilotCommand(
      (process.env.PILOT_ARM ?? "local") + "-" + row.check_name + "-test",
      rest[1]!,
      [process.execPath, "--import", "./scripts/tsx.mjs", "scripts/ci-run-node-test-shard.mts"],
      pilotRowEnvironment(row, process.env),
    );
  }
  if (operation === "report") {
    assert.equal(rest.length, 1);
    const files = fs
      .readdirSync(rest[0]!)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(rest[0]!, name));
    const receipts = summarizePilotReceipts(
      files.map((file) => JSON.parse(fs.readFileSync(file, "utf8"))),
    );
    const lines = [
      "## Shared runtime qualification",
      "",
      "| Stage | Seconds |",
      "| --- | ---: |",
      ...receipts.map(
        (receipt) => "| " + receipt.label + " | " + receipt.seconds.toFixed(2) + " |",
      ),
      "",
      "Stage wall times are not CPU time or billing. Include setup, producer upload, consumer download/extraction and dependency wait before deciding whether sharing is worthwhile.",
      "Normal CI and required checks are unchanged; this run does not authorize a cutover.",
    ];
    const summary = lines.join("\n") + "\n";
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    return 0;
  }
  throw new Error("Usage: ci-shared-runtime-pilot.mts <plan|measure|run|report> ...");
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
