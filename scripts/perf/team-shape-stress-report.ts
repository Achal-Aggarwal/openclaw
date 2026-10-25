// Report only completed real-Gateway captures; missing evidence is never reported as zero cost.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { GatewayResourceSnapshot } from "../lib/gateway-bench-profile.ts";

type RpcSummary = { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
type Telemetry = {
  mode: string;
  durationMs: number;
  mainThreadCpuPercent: number;
  hostLoad?: { initial: number[]; final: number[]; samples: number; mean: number[]; max: number[] };
  sampledAllocatedBytesPerSecond: number | null;
  gc: Record<
    string,
    { count: number; totalMs: number; p95Ms: number; p99Ms: number; maxMs: number }
  >;
  eventLoop: { count: number; p95Ms: number | null; p99Ms: number | null; maxMs: number | null };
  stalls: { count: number; totalMs: number; maxMs: number };
  lastSample: { memory: NodeJS.MemoryUsage };
};
type SoakResult = {
  completedTurns: number;
  teamStress: {
    committedWrites: number;
    prometheusScrapes: number;
    rpcMinutes: Array<{ methods: Record<string, { errors: number }> }>;
  };
  memorySamples: Array<{ collectedGarbage: boolean; resources: GatewayResourceSnapshot }>;
  samples: Array<{
    toolCalls: number;
    toolResults: number;
    rpc: Record<string, { latenciesMs: number[] }>;
  }>;
};
type RunOptions = {
  resultDir: string;
  side: "base" | "candidate";
  pair: number;
  mode: string;
  smoke: boolean;
};
export type StressRun = RunOptions & {
  durationMs: number;
  metrics: Record<string, number | null>;
  rpc: Record<string, RpcSummary>;
  gc: Telemetry["gc"];
  stalls: Telemetry["stalls"];
  workerHeaps: GatewayResourceSnapshot["workers"];
  rpcMinutes: SoakResult["teamStress"]["rpcMinutes"];
  nativeOldGenerationSamples: Array<{ scrape: number; bytes: number | null }>;
  sessionsListHandler?: ReturnType<typeof readHandlerWindow>;
  memoryScope: string;
};
const MIB = 1024 ** 2;

function readHandlerWindow(resultDir: string) {
  const windowPath = path.join(resultDir, "stress-prometheus-window.json");
  // Earlier stored captures have only periodic scrapes, with no measured-window baseline.
  if (!existsSync(windowPath)) {
    return null;
  }
  const read = (side: string) => {
    const samples = new Map<string, number>();
    for (const line of readFileSync(
      path.join(resultDir, `stress-prometheus-${side}.prom`),
      "utf8",
    ).split("\n")) {
      const match =
        /^openclaw_gateway_rpc_handler_seconds_(bucket|count|sum)\{([^}]*)\} ([\d.eE+-]+)$/.exec(
          line,
        );
      if (!match || !/(?:^|,)method="sessions\.list"(?:,|$)/.test(match[2]!)) {
        continue;
      }
      const key = match[1] === "bucket" ? /(?:^|,)le="([^"]+)"/.exec(match[2]!)?.[1] : match[1];
      if (key) {
        samples.set(key, Number(match[3]));
      }
    }
    return samples;
  };
  const start = read("start");
  const end = read("end");
  if (!end.has("count") || !end.has("sum")) {
    throw new Error("Stress capture lacks server-side sessions.list handler histogram");
  }
  const deltas = new Map([...end].map(([key, value]) => [key, value - (start.get(key) ?? 0)]));
  if ([...deltas.values()].some((value) => value < 0)) {
    throw new Error("Server-side sessions.list histogram reset during stress capture");
  }
  const count = deltas.get("count")!;
  const boundSeconds = (bound: string) => (bound === "+Inf" ? Infinity : Number(bound));
  const buckets = [...deltas]
    .filter(([key]) => key !== "count" && key !== "sum")
    .map(([upperBoundSeconds, bucketCount]) => ({ upperBoundSeconds, count: bucketCount }))
    .toSorted((a, b) => boundSeconds(a.upperBoundSeconds) - boundSeconds(b.upperBoundSeconds));
  const percentile = (fraction: number) => {
    if (!count) {
      return null;
    }
    let lower = 0;
    let previousCount = 0;
    for (const bucket of buckets) {
      const upper = boundSeconds(bucket.upperBoundSeconds);
      if (bucket.count >= count * fraction) {
        return Number.isFinite(upper)
          ? (lower +
              ((count * fraction - previousCount) / (bucket.count - previousCount)) *
                (upper - lower)) *
              1000
          : null;
      }
      lower = upper;
      previousCount = bucket.count;
    }
    return null;
  };
  return {
    count,
    totalMs: deltas.get("sum")! * 1000,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    buckets,
    window: JSON.parse(readFileSync(windowPath, "utf8")),
    scope:
      "Server handler return/throw duration; cumulative Prometheus buckets differenced across workload boundaries. Quantiles are bucket-interpolated estimates, not client round-trip times. Boundary scrape timestamps bound the capture.",
  };
}

export function summarizeStressRun(options: RunOptions): StressRun {
  const result: SoakResult = JSON.parse(
    readFileSync(path.join(options.resultDir, "result.json"), "utf8"),
  );
  const telemetry: Telemetry = JSON.parse(
    readFileSync(path.join(options.resultDir, "stress-telemetry.json"), "utf8"),
  );
  if (!(telemetry.durationMs >= (options.smoke ? 1 : 600_000))) {
    throw new Error("Stress capture is shorter than the required measured duration");
  }
  if (
    telemetry.mode !== (options.mode === "allocation" ? "allocation-diagnostic" : "untraced-timing")
  ) {
    throw new Error("Stress telemetry instrumentation does not match the requested pass");
  }
  const methods = new Map<string, number[]>();
  for (const sample of result.samples) {
    for (const [method, measurement] of Object.entries(sample.rpc)) {
      const latencies = methods.get(method) ?? [];
      latencies.push(...measurement.latenciesMs);
      methods.set(method, latencies);
    }
  }
  const rpc = Object.fromEntries(
    [...methods].map(([method, latencies]) => {
      const sorted = latencies.toSorted((a, b) => a - b);
      const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
      return [
        method,
        {
          count: sorted.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxMs: sorted.at(-1)!,
        },
      ];
    }),
  );
  for (const method of [
    "sessions.list",
    "chat.history",
    "chat.startup",
    "sessions.diff",
    "connect",
    "chat.inject",
  ]) {
    if (!rpc[method]?.count) {
      throw new Error(`Stress workload did not exercise ${method}`);
    }
  }
  if (
    result.teamStress.rpcMinutes.some((minute) =>
      Object.values(minute.methods).some((method) => method.errors),
    )
  ) {
    throw new Error("Stress workload contains failed RPCs");
  }
  const toolCalls = result.samples.reduce((sum, sample) => sum + sample.toolCalls, 0);
  const toolResults = result.samples.reduce((sum, sample) => sum + sample.toolResults, 0);
  if (
    !(
      result.completedTurns > 0 &&
      toolCalls > 0 &&
      toolCalls === toolResults &&
      result.teamStress.committedWrites > 0 &&
      result.teamStress.prometheusScrapes > 0
    )
  ) {
    throw new Error(
      "Stress workload lacks completed turns, tools, timestamp writes, or Prometheus scrapes",
    );
  }
  if (options.mode === "allocation" && !(telemetry.sampledAllocatedBytesPerSecond! > 0)) {
    throw new Error("Stress allocation pass did not record allocations");
  }
  const resources = result.memorySamples.findLast((sample) => !sample.collectedGarbage)?.resources;
  const collected = result.memorySamples.findLast((sample) => sample.collectedGarbage)?.resources;
  const workers = resources?.workers;
  const oldGeneration = collected?.heapSpaces
    .filter((space) => ["old_space", "large_object_space"].includes(space.space_name))
    .reduce((sum, space) => sum + space.space_used_size, 0);
  const memory = telemetry.lastSample.memory;
  const durationMinutes = telemetry.durationMs / 60_000;
  const list = rpc["sessions.list"]!;
  const nativeOldGenerationSamples = readdirSync(options.resultDir)
    .filter((file) => /^stress-prometheus-\d+\.prom$/.test(file))
    .map((file) => {
      const text = readFileSync(path.join(options.resultDir, file), "utf8");
      const value =
        /^openclaw_heap_old_generation_after_gc_bytes\{thread="main"\} ([\d.eE+-]+)$/m.exec(
          text,
        )?.[1];
      return {
        scrape: Number(file.match(/\d+/)![0]),
        bytes: value === undefined ? null : Number(value),
      };
    })
    .toSorted((a, b) => a.scrape - b.scrape);
  const nativeOldGeneration = nativeOldGenerationSamples.at(-1)?.bytes;
  const sessionsListHandler = readHandlerWindow(options.resultDir);
  return {
    ...options,
    durationMs: telemetry.durationMs,
    rpc,
    gc: telemetry.gc,
    stalls: telemetry.stalls,
    workerHeaps: workers,
    rpcMinutes: result.teamStress.rpcMinutes,
    nativeOldGenerationSamples,
    sessionsListHandler,
    memoryScope:
      "RSS/main heap at timing stop; workers at last non-forced-GC resource sample; old generation from the last scraped native major-GC epilogue; settled old generation after explicit GC outside timing.",
    metrics: {
      mainThreadCpuPercent: telemetry.mainThreadCpuPercent,
      hostLoadOneMinuteMean: telemetry.hostLoad?.mean[0] ?? null,
      hostLoadOneMinuteMax: telemetry.hostLoad?.max[0] ?? null,
      allocationMiBPerSecond:
        telemetry.sampledAllocatedBytesPerSecond === null
          ? null
          : telemetry.sampledAllocatedBytesPerSecond / MIB,
      gcSecondsPerMinute:
        Object.values(telemetry.gc).reduce((sum, metric) => sum + metric.totalMs, 0) /
        1000 /
        durationMinutes,
      eventLoopP95Ms: telemetry.eventLoop.p95Ms,
      eventLoopP99Ms: telemetry.eventLoop.p99Ms,
      eventLoopCount: telemetry.eventLoop.count,
      eventLoopMaxMs: telemetry.eventLoop.maxMs,
      sessionsListP50Ms: list.p50Ms,
      sessionsListP99Ms: list.p99Ms,
      sessionsListCount: list.count,
      sessionsListHandlerCount: sessionsListHandler?.count ?? null,
      sessionsListHandlerP95Ms: sessionsListHandler?.p95Ms ?? null,
      sessionsListHandlerP99Ms: sessionsListHandler?.p99Ms ?? null,
      sessionsListHandlerMeanMs: sessionsListHandler?.count
        ? sessionsListHandler.totalMs / sessionsListHandler.count
        : null,
      sessionsListPerMinute: list.count / durationMinutes,
      rpcPerMinute:
        Object.values(rpc).reduce((sum, method) => sum + method.count, 0) / durationMinutes,
      rssMiB: memory.rss / MIB,
      heapMiB: memory.heapUsed / MIB,
      oldGenerationAfterGcMiB: nativeOldGeneration == null ? null : nativeOldGeneration / MIB,
      settledOldGenerationMiB: oldGeneration === undefined ? null : oldGeneration / MIB,
      workerHeapMiB:
        workers?.workerHeapUsedBytes === undefined || workers.workerMemoryMissing.length > 0
          ? null
          : workers.workerHeapUsedBytes / MIB,
      workerHeapCount: workers?.workerHeapSampledCount ?? null,
      workerMemoryMissing: workers?.workerMemoryMissing.length ?? null,
      turns: result.completedTurns,
      toolCalls,
      toolResults,
      committedWrites: result.teamStress.committedWrites,
      prometheusScrapes: result.teamStress.prometheusScrapes,
      stalls: telemetry.stalls.count,
    },
  };
}

/** Mean signed paired deltas; never average percentages from tiny baselines or minute quantiles. */
export function compareStressRuns(runs: StressRun[]) {
  const rows = [];
  for (const mode of new Set(runs.map((run) => run.mode))) {
    const scoped = runs.filter((run) => run.mode === mode);
    const pairs = [...new Set(scoped.map((run) => run.pair))].map((pair) => ({
      base: scoped.find((run) => run.pair === pair && run.side === "base"),
      candidate: scoped.find((run) => run.pair === pair && run.side === "candidate"),
    }));
    for (const metric of new Set(scoped.flatMap((run) => Object.keys(run.metrics)))) {
      const values = pairs.flatMap(({ base, candidate }) => {
        const a = base?.metrics[metric],
          b = candidate?.metrics[metric];
        return typeof a === "number" &&
          Number.isFinite(a) &&
          typeof b === "number" &&
          Number.isFinite(b)
          ? [{ base: a, candidate: b, delta: b - a }]
          : [];
      });
      const mean = (key: "base" | "candidate" | "delta") =>
        values.length ? values.reduce((sum, value) => sum + value[key], 0) / values.length : null;
      const base = mean("base"),
        candidate = mean("candidate"),
        absolute = mean("delta");
      const tailSamples = metric.startsWith("eventLoop")
        ? "eventLoopCount"
        : metric.startsWith("sessionsListHandler")
          ? "sessionsListHandlerCount"
          : "sessionsListCount";
      const minimum = metric.includes("P99") ? 1000 : metric.includes("P95") ? 200 : 0;
      const context =
        values.length !== pairs.length || !values.length
          ? "inconclusive: missing paired metric"
          : scoped.some((run) => run.smoke)
            ? "smoke only"
            : mode === "allocation" && metric !== "allocationMiBPerSecond"
              ? "diagnostic pass"
              : minimum && scoped.some((run) => (run.metrics[tailSamples] ?? 0) < minimum)
                ? `context: fewer than ${minimum} tail samples`
                : "measured; apply lane acceptance rules";
      rows.push({
        metric,
        mode,
        base,
        candidate,
        absolute,
        percent: base && absolute !== null ? (absolute / base) * 100 : null,
        pairs: values.length,
        pairedDeltas: values.map((value) => value.delta),
        context,
      });
    }
  }
  return rows;
}
