/**
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-worktree-admission-measure.ts
 *   --arm base --mode timing --output .local/sandbox-admission/base-timing
 * Repeat with --arm candidate, counterbalance arm order, then repeat both with
 * --mode allocation. Default: 2,000 admissions after 20 warmups, 32 checkout IDs.
 * Calls the real previous global-allocation and replacement checkout-mutation
 * lease APIs against fresh synthetic SQLite state. Both perform the same final
 * live-authority check. No mocks, native checkout, projection, or disk writes
 * inside the lease body: this isolates admission and pending-slot-recovery cost,
 * not the latency benefit from concurrent preparation. Use the isolated Gateway
 * workload for that. Main-thread CPU/allocation exclude worker cost; process CPU
 * includes threads. Timing/GC comes from untraced runs; allocation passes use
 * 16 KiB sampling including collected objects. No forced GC. Own state is removed
 * after owner shutdown; result.json remains under --output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.arm === "base" || values.arm === "candidate", "--arm base|candidate required");
assert(values.mode === "timing" || values.mode === "allocation", "--mode timing|allocation");
assert(values.output, "--output directory required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
const output = path.resolve(values.output);
await fs.mkdir(output, { recursive: true });
const state = await fs.mkdtemp(path.join(output, "state-"));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, "openclaw.json");
const { initializeSqliteRuntime } = await import("../../src/infra/sqlite-runtime-initialize.js");
await initializeSqliteRuntime();
const { withWorktreeAllocationLease, withWorktreeMutationLease } =
  await import("../../src/agents/worktrees/allocation.js");
const { closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db-cache.js");
type Guard = import("../../src/agents/worktrees/allocation.js").WorktreeAllocationGuard;
const inspector = new Session();
let admitted = 0;
const body = async (guard: Guard) => {
  guard.commitGuard?.();
  admitted++;
};
const operation = (index: number) =>
  values.arm === "base"
    ? withWorktreeAllocationLease({ env: process.env }, body)
    : withWorktreeMutationLease({ env: process.env, id: `projection-${index % 32}` }, body);
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
try {
  for (let index = 0; index < 20; index++) {
    await operation(index);
  }
  admitted = 0;
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gc = new GCProfiler();
  gc.start();
  const hostLoadBefore = loadavg(),
    memoryBefore = process.memoryUsage();
  const processCpuBefore = process.cpuUsage(),
    threadCpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const durations: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    await operation(index);
    durations.push(performance.now() - before);
  }
  const wallMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadCpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const collections = gc.stop()?.statistics ?? [];
  const memoryAfter = process.memoryUsage(),
    hostLoadAfter = loadavg();
  let sampledBytesPerOperation: number | undefined;
  if (values.mode === "allocation") {
    sampledBytesPerOperation =
      bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head) / iterations;
  }
  assert.equal(admitted, iterations);
  durations.sort((left, right) => left - right);
  const result = {
    arm: values.arm,
    mode: values.mode,
    iterations,
    admitted,
    checkoutIds: 32,
    scope:
      "real uncontended admission; empty pending-slot registry; excludes projection/native work",
    node: process.version,
    allocationOwnerSha256: createHash("sha256")
      .update(
        await fs.readFile(new URL("../../src/agents/worktrees/allocation.ts", import.meta.url)),
      )
      .digest("hex"),
    wallMs,
    samples: durations.length,
    p50Ms: durations[Math.ceil(iterations * 0.5) - 1],
    p95Ms: durations[Math.ceil(iterations * 0.95) - 1],
    mainCpuUsPerOperation: (threadCpu.user + threadCpu.system) / iterations,
    processCpuUsPerOperation: (processCpu.user + processCpu.system) / iterations,
    sampledBytesPerOperation,
    gc: [...new Set(collections.map((entry) => entry.gcType))].map((kind) => {
      const pauses = collections
        .filter((entry) => entry.gcType === kind)
        .map((entry) => entry.cost / 1000);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...pauses),
      };
    }),
    memoryBefore,
    memoryAfter,
    hostLoadBefore,
    hostLoadAfter,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(path.join(output, "result.json"), json);
  process.stdout.write(json);
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(state, { recursive: true });
}
