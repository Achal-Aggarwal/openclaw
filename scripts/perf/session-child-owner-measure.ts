// In-process owner workload; run with --expose-gc on an approved benchmark host.
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { SourceMap, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { SubagentRunReadIndex } from "../../src/agents/subagents/registry/subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { SessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    parents: { type: "string", default: "48" },
    children: { type: "string", default: "200" },
    updates: { type: "string", default: "8000" },
    warmup: { type: "string", default: "1000" },
    mode: { type: "string", default: "timing" },
    "team-shape": { type: "boolean", default: false },
    sessions: { type: "string", default: "10800" },
    workload: { type: "string", default: "owner" },
    "list-path": { type: "string", default: "churn" },
    lists: { type: "string", default: "30" },
    serialized: { type: "boolean", default: false },
    "freeze-clock": { type: "boolean", default: false },
    samples: { type: "string", default: "1" },
    controlled: { type: "boolean", default: false },
  },
});
const integer = (
  name: "parents" | "children" | "updates" | "warmup" | "sessions" | "lists" | "samples",
) => parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const parentCount = integer("parents");
const childCount = integer("children");
const updates = integer("updates");
const warmup = integer("warmup");
assert.ok(values["state-dir"], "--state-dir must name a new isolated directory");
assert.ok(
  ["timing", "allocation", "census", "equivalence"].includes(values.mode),
  "Invalid --mode",
);
assert.ok(values.workload === "owner" || values.workload === "list", "Invalid --workload");
assert.ok(values.workload !== "list" || values["team-shape"], "--workload list needs --team-shape");
assert.ok(
  ["churn", "hit", "miss", "run-churn"].includes(values["list-path"]),
  "Invalid --list-path",
);
assert.ok(values["list-path"] === "churn" || values.workload === "list");
assert.ok(!values.controlled || (process.send && values.workload === "list"));
assert.ok(global.gc, "Run with --expose-gc");
const collectGarbage = global.gc;
const root = path.resolve(values["state-dir"]);
const config = path.join(root, "openclaw.json");
const now = Date.UTC(2026, 9, 25);
if (values["freeze-clock"]) {
  Date.now = () => now;
}
let fixture:
  | Awaited<ReturnType<typeof import("./team-shape-fixture.ts").generateTeamShapeFixture>>
  | undefined;
if (values["team-shape"]) {
  const { generateTeamShapeFixture, parseTeamShapeOptions } =
    await import("./team-shape-fixture.ts");
  const sessions = integer("sessions");
  fixture = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--sessions",
      String(sessions),
      "--runs",
      String(Math.floor((sessions * 4_300) / 10_800)),
      "--team-stress",
      "--settled-runs",
      "--transcript-mib",
      "0",
      "--projects",
      "0",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--now",
      String(now),
      "--seed",
      "1711",
    ]),
  );
  process.env = fixture.env;
} else {
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(path.join(root, "home"));
  writeFileSync(config, JSON.stringify({ plugins: { enabled: false } }));
  process.env = {
    ...createGatewayBenchEnv(path.join(root, "home"), config, { startupTrace: false }),
    OPENCLAW_STATE_DIR: root,
  };
}
const memory = await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const registry = await import("../../src/infra/agent-run-registry.js");
const { publishSubagentRunChanges } =
  await import("../../src/agents/subagents/registry/subagent-registry-publication.js");
const { createSubagentSessionListReadIndex } =
  await import("../../src/agents/subagents/registry/subagent-registry-read-index.js");
const { resolveSessionChildOwners } = await import("../../src/gateway/session-utils-core.js");
const parentKeys = Array.from({ length: parentCount }, (_, index) => `agent:main:parent-${index}`);
const active: SubagentRunRecord[] = [];
const claims = new Map<string, string>();
const rows: Array<{ key: string; entry: SessionEntry }> = [];
const snapshot = new Map<string, SubagentRunReadRecord>();
let projection: SessionRowProjection | undefined;
let listSessions:
  | typeof import("../../src/gateway/session-utils-list.js").listProjectedSessions
  | undefined;
let releaseForeground: (() => void) | undefined;
if (fixture) {
  const { captureRuntimeConfigAsyncReader } = await import("../../src/config/config.js");
  const { createSessionRowProjection } =
    await import("../../src/gateway/session-row-projection.js");
  const { retainSessionListForegroundWork } =
    await import("../../src/gateway/session-projection-work.js");
  const { createSubagentSessionListReadView } =
    await import("../../src/agents/subagents/registry/subagent-registry-state.js");
  const cfg = await captureRuntimeConfigAsyncReader()();
  releaseForeground = retainSessionListForegroundWork();
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  rows.push(...projection.selectEntries().map(({ key, entry }) => ({ key, entry })));
  assert.equal(rows.length, integer("sessions"), "Projection must retain every fixture row");
  const sessions = new Map(rows.map((row) => [row.key, row.entry]));
  const source = createSubagentSessionListReadView({ env: process.env });
  await source.prepare();
  for (const retained of source.runs().values()) {
    const child = sessions.get(retained.childSessionKey);
    assert.ok(child, "Registry child must belong to the generated fixture");
    const entry: SubagentRunRecord = {
      ...retained,
      childSessionIdentity: {
        sessionId: child.sessionId,
        lifecycleRevision: child.lifecycleRevision,
      },
      requesterAgentId: "main",
      requesterDisplayKey: retained.requesterSessionKey,
      task: "Synthetic child-owner work",
      cleanup: "keep",
    };
    if (active.length < parentCount) {
      entry.execution = { status: "running", startedAt: now };
      entry.cleanupCompletedAt = undefined;
      active.push(entry);
      parentKeys[active.length - 1] = entry.requesterSessionKey;
    }
    memory.subagentRuns.set(entry.runId, entry);
    snapshot.set(entry.runId, memory.immutableSubagentRunSessionList(entry));
  }
  assert.equal(snapshot.size, Math.floor((integer("sessions") * 4_300) / 10_800));
  assert.equal(active.length, parentCount, "Fixture needs enough records for churn");
  if (values.workload === "list") {
    ({ listProjectedSessions: listSessions } =
      await import("../../src/gateway/session-utils-list.js"));
    publishSubagentRunChanges();
    await projection.ensureMaterialized();
  } else {
    projection.dispose();
    projection = undefined;
    releaseForeground();
    releaseForeground = undefined;
  }
} else {
  for (let parent = 0; parent < parentCount; parent++) {
    for (let child = 0; child < childCount; child++) {
      const runId = `synthetic-${parent}-${child}`;
      const key = `agent:main:subagent:${runId}`;
      const entry: SubagentRunRecord = {
        runId,
        childSessionKey: key,
        childAgentId: "main",
        childSessionIdentity: { sessionId: runId },
        requesterSessionKey: parentKeys[parent]!,
        requesterAgentId: "main",
        requesterDisplayKey: parentKeys[parent]!,
        controllerSessionKey: parentKeys[parent]!,
        task: "Synthetic child-owner work",
        cleanup: "keep",
        generation: 1,
        createdAt: now - 1000,
        execution:
          child === 0
            ? { status: "running", startedAt: now }
            : {
                status: "terminal",
                startedAt: now - 1000,
                endedAt: now - 500,
                outcome: { status: "ok" },
              },
        cleanupCompletedAt: child === 0 ? undefined : now,
        delivery: { status: "not_required" },
      };
      memory.subagentRuns.set(runId, entry);
      snapshot.set(runId, memory.immutableSubagentRunSessionList(entry));
      if (child === 0) {
        active.push(entry);
      }
      if (child < 4) {
        rows.push({
          key,
          entry: {
            sessionId: runId,
            updatedAt: now,
            spawnedBy: parentKeys[parent],
            spawnDepth: 1,
            parentSessionKey: parentKeys[parent],
            ...(child % 3 ? { archivedAt: now } : {}),
          },
        });
      }
    }
  }
}
function claim(entry: SubagentRunRecord, clock: number) {
  const token = registry.claimAgentRunContext(
    entry.runId,
    {
      agentId: "main",
      sessionKey: entry.childSessionKey,
      sessionId: entry.childSessionIdentity?.sessionId,
      lifecycleStartedAt: clock,
      projectSessionActive: true,
      isControlUiVisible: true,
    },
    { trackOwner: true, ownsContext: true },
  );
  assert.ok(token);
  claims.set(entry.runId, token);
}
for (const entry of active) {
  claim(entry, now);
}
const resident =
  values.workload === "owner"
    ? createSubagentSessionListReadIndex(
        {
          snapshotIdentity: () => memory.subagentRuns,
          runs(ids) {
            if (!ids) {
              return snapshot;
            }
            const selected = new Map<string, SubagentRunReadRecord>();
            for (const id of ids) {
              const entry = memory.subagentRuns.get(id);
              if (entry) {
                selected.set(id, memory.immutableSubagentRunSessionList(entry));
              }
            }
            return selected;
          },
          prepare: async () => {},
        },
        now,
      )
    : undefined;
const { parseAgentSessionKey } = await import("../../src/sessions/session-key-utils.js");
const { serializeGatewayFrame } = await import("../../src/gateway/serialized-json.js");
const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.js");
const { getSessionRowSelectionMetrics } = await import("../../src/infra/gateway-work-metrics.js");
const ownerRows = rows.map((row) => ({ ...row, parsedKey: parseAgentSessionKey(row.key) }));
const requesterRoots = [
  ...new Set(Array.from(snapshot.values(), (entry) => entry.requesterSessionKey)),
];
const lookup = memory.getSubagentSessionReadLookup(memory.subagentRuns);
let previousTopology = lookup.captureTopology();
let topologyChanges = 0;
let checksum = 0;
let sequence = 0;
let ownerCpuMicros = 0;
let ownerReads = 0;
let returnedRows = 0;
let descendantQueries = 0;
let responseBytes = 0;
let sampleOwnerRegions = false;
const allocationRegions: {
  owner: HeapProfiler.SamplingHeapProfile[];
  descendant: HeapProfiler.SamplingHeapProfile[];
  list: HeapProfiler.SamplingHeapProfile[];
} = { owner: [], descendant: [], list: [] };
async function sampleAllocationRegion(
  read: () => void | Promise<void>,
  profiles: HeapProfiler.SamplingHeapProfile[],
): Promise<void> {
  // Temporal attribution survives V8 inlining; retain profiles only after sampling stops.
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  try {
    await read();
  } finally {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    profiles.push(profile);
  }
}
function totalAllocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  let bytes = node.selfSize;
  for (const child of node.children) {
    bytes += totalAllocatedBytes(child);
  }
  return bytes;
}
function updateRun() {
  const index = sequence % parentCount;
  const previous = active[index]!;
  const clock = now + Math.floor((sequence * 1000) / 48);
  const running = Math.floor(sequence / parentCount) % 2 === 0;
  const token = claims.get(previous.runId);
  if (token) {
    registry.releaseAgentRunContext(previous.runId, token);
  }
  claims.delete(previous.runId);
  const entry: SubagentRunRecord = {
    ...previous,
    execution: running
      ? { status: "running", startedAt: clock }
      : { status: "terminal", startedAt: clock - 1000, endedAt: clock, outcome: { status: "ok" } },
    cleanupCompletedAt: running ? undefined : clock,
  };
  memory.subagentRuns.set(entry.runId, entry);
  if (running) {
    claim(entry, clock);
  }
  active[index] = entry;
  publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  sequence++;
}

function readActiveDescendants(index: SubagentRunReadIndex<SubagentRunReadRecord>): void {
  let rootIndex = 0;
  while (rootIndex < requesterRoots.length) {
    checksum += index.countActiveDescendantRuns(requesterRoots[rootIndex++]!);
  }
  descendantQueries += requesterRoots.length;
}

async function resolveList() {
  if (projection && listSessions) {
    const pageSize = Math.min(100, rows.length);
    const result = await listSessions({
      projection,
      acceptsSerializedJson: values.serialized,
      opts: {
        archived: "all",
        limit: pageSize,
        rowMode: "compact",
        includeGlobal: true,
        includeUnknown: true,
      },
    });
    assert.equal(result.sessions.length, pageSize, "The complete requested page must be presented");
    returnedRows += result.sessions.length;
    checksum += result.sessions.length + (result.totalCount ?? 0);
    if (values.serialized) {
      const frame = serializeGatewayFrame({ type: "res", id: "list", ok: true, payload: result });
      responseBytes += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    }
    return;
  }
  const clock = now + Math.floor((sequence * 1000) / 48);
  assert.ok(resident);
  const index = resident.read(clock);
  const topology = lookup.captureTopology();
  if (topology !== previousTopology) {
    topologyChanges++;
  }
  previousTopology = topology;
  if (sampleOwnerRegions) {
    const readDescendants = () => readActiveDescendants(index);
    const readOwners = () => {
      const before = process.threadCpuUsage();
      for (const row of ownerRows) {
        checksum += resolveSessionChildOwners({ ...row, now: clock, subagentRuns: index }).length;
      }
      const cpu = process.threadCpuUsage(before);
      ownerCpuMicros += cpu.user + cpu.system;
    };
    await sampleAllocationRegion(readDescendants, allocationRegions.descendant);
    await sampleAllocationRegion(readOwners, allocationRegions.owner);
    ownerReads += rows.length;
    return;
  }
  readActiveDescendants(index);
  const before = process.threadCpuUsage();
  for (const row of ownerRows) {
    checksum += resolveSessionChildOwners({ ...row, now: clock, subagentRuns: index }).length;
  }
  const cpu = process.threadCpuUsage(before);
  ownerCpuMicros += cpu.user + cpu.system;
  ownerReads += rows.length;
}
async function run(count: number) {
  let completed = 0;
  let lists = 0;
  let updateCpuMicros = 0;
  let resolutionCpuMicros = 0;
  if (values["list-path"] !== "churn") {
    for (let list = 0; list < count; list++) {
      let before = process.threadCpuUsage();
      if (values["list-path"] === "run-churn") {
        for (let step = 0; step < 33; step++) {
          updateRun();
          completed++;
        }
      } else if (values["list-path"] === "miss") {
        for (let step = 0; step < 33; step++) {
          const row = rows[sequence++ % rows.length]!;
          const parsed = parseAgentSessionKey(row.key);
          assert.ok(parsed);
          const entry = { ...row.entry, label: `Synthetic metadata revision ${sequence}` };
          replaceSessionEntrySync({ agentId: parsed.agentId, sessionKey: row.key }, entry);
          row.entry = entry;
          completed++;
        }
      }
      let cpu = process.threadCpuUsage(before);
      updateCpuMicros += cpu.user + cpu.system;
      before = process.threadCpuUsage();
      if (sampleListRegions) {
        await sampleAllocationRegion(resolveList, allocationRegions.list);
      } else {
        await resolveList();
      }
      cpu = process.threadCpuUsage(before);
      resolutionCpuMicros += cpu.user + cpu.system;
      lists++;
      await nextTurn();
    }
    return { updates: completed, lists, updateCpuMicros, resolutionCpuMicros };
  }
  while (completed < count) {
    // 48 updates/s : 1.44 lists/s = 100 updates per three resolution passes.
    const batch = Math.min(count - completed, [33, 33, 34][lists % 3]!);
    let before = process.threadCpuUsage();
    for (let step = 0; step < batch; step++) {
      updateRun();
    }
    let cpu = process.threadCpuUsage(before);
    updateCpuMicros += cpu.user + cpu.system;
    before = process.threadCpuUsage();
    await resolveList();
    cpu = process.threadCpuUsage(before);
    resolutionCpuMicros += cpu.user + cpu.system;
    completed += batch;
    lists++;
    await nextTurn();
  }
  return { updates: completed, lists, updateCpuMicros, resolutionCpuMicros };
}
const gcEntries: Array<{ at: number; kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const json: unknown = entry.toJSON();
    const detail = isRecord(json) ? json.detail : undefined;
    assert.ok(isRecord(detail) && typeof detail.kind === "number");
    gcEntries.push({ at: entry.startTime, kind: detail.kind, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
let sampleListRegions = false;
async function measure(sample: number) {
  allocationRegions.list.length = 0;
  allocationRegions.owner.length = 0;
  allocationRegions.descendant.length = 0;
  collectGarbage();
  await nextTurn();
  await nextTurn();
  gcEntries.length = 0;
  topologyChanges = 0;
  checksum = 0;
  ownerCpuMicros = 0;
  ownerReads = 0;
  returnedRows = 0;
  descendantQueries = 0;
  responseBytes = 0;
  const heapBefore = process.memoryUsage().heapUsed;
  const countersBefore = getSessionRowSelectionMetrics();
  if (values.mode === "census") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  } else if (
    values.mode === "allocation" &&
    values.workload === "list" &&
    values["list-path"] === "churn"
  ) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  sampleOwnerRegions = values.mode === "allocation" && values.workload === "owner";
  sampleListRegions = values.mode === "allocation" && values["list-path"] !== "churn";
  const started = performance.now();
  const before = process.threadCpuUsage();
  const work = await run(values["list-path"] === "churn" ? updates : integer("lists"));
  const cpu = process.threadCpuUsage(before);
  const ended = performance.now();
  const heapAfter = process.memoryUsage().heapUsed;
  const countersAfter = getSessionRowSelectionMetrics();
  await nextTurn();
  await nextTurn();
  if (values.mode === "census") {
    const { result } = await inspector.post("Profiler.takePreciseCoverage");
    await inspector.post("Profiler.stopPreciseCoverage");
    const calls = result
      .filter((script) =>
        /\/(session-row-presentation|session-utils-(core|row)|subagent-(registry-(memory|read|queries|read-topology)|child-owner-match|run-generation))\.ts$/.test(
          script.url,
        ),
      )
      .flatMap((script) =>
        script.functions.map((fn) => ({
          file: path.basename(script.url),
          name: fn.functionName,
          calls: fn.ranges[0]?.count ?? 0,
          callsPerList: (fn.ranges[0]?.count ?? 0) / work.lists,
        })),
      );
    writeFileSync(path.join(root, "calls.json"), JSON.stringify(calls, null, 2));
  }
  let allocatedBytes: number | undefined;
  let listProfiles: HeapProfiler.SamplingHeapProfile[] = [];
  let ownerRegionAllocatedBytes: number | undefined;
  let descendantRegionAllocatedBytes: number | undefined;
  if (sampleOwnerRegions) {
    writeFileSync(path.join(root, "allocation-regions.json"), JSON.stringify(allocationRegions));
    ownerRegionAllocatedBytes = allocationRegions.owner.reduce(
      (bytes, profile) => bytes + totalAllocatedBytes(profile.head),
      0,
    );
    descendantRegionAllocatedBytes = allocationRegions.descendant.reduce(
      (bytes, profile) => bytes + totalAllocatedBytes(profile.head),
      0,
    );
    assert.equal(allocationRegions.owner.length, work.lists);
    assert.equal(allocationRegions.descendant.length, work.lists);
  } else if (sampleListRegions) {
    listProfiles = allocationRegions.list;
    writeFileSync(path.join(root, "allocation-regions.json"), JSON.stringify(allocationRegions));
    allocatedBytes = allocationRegions.list.reduce(
      (bytes, profile) => bytes + totalAllocatedBytes(profile.head),
      0,
    );
    assert.equal(allocationRegions.list.length, work.lists);
  } else if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    listProfiles = [profile];
    writeFileSync(path.join(root, "allocation.heapprofile"), JSON.stringify(profile));
    allocatedBytes = totalAllocatedBytes(profile.head);
  }
  if (listProfiles.length && !values.controlled) {
    const maps = new Map<string, SourceMap>();
    inspector.on("Debugger.scriptParsed", ({ params }) => {
      const prefix = "data:application/json;base64,";
      if (params.sourceMapURL?.startsWith(prefix)) {
        maps.set(
          params.url,
          new SourceMap(
            JSON.parse(Buffer.from(params.sourceMapURL.slice(prefix.length), "base64").toString()),
          ),
        );
      }
    });
    // Map tsx's single-line generated frames after sampling, outside the measured window.
    await inspector.post("Debugger.enable");
    await inspector.post("Debugger.disable");
    inspector.removeAllListeners("Debugger.scriptParsed");
    const sites = new Map<string, number>();
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, parents: string[] = []) => {
      const frame = node.callFrame;
      const source = maps.get(frame.url)?.findEntry(frame.lineNumber, frame.columnNumber);
      const generated = `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
      const name = `${frame.functionName || "(anonymous)"}@${generated}${source ? ` -> ${JSON.stringify(source)}` : ""}`;
      const key = [...parents.slice(-3), name].join(" < ");
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize / work.lists);
      for (const child of node.children) {
        visit(child, [...parents, name]);
      }
    };
    for (const profile of listProfiles) {
      visit(profile.head);
    }
    const ranked = [...sites].toSorted((left, right) => right[1] - left[1]);
    writeFileSync(path.join(root, "allocation-sites.json"), JSON.stringify(ranked, null, 2));
    maps.clear();
    console.log(JSON.stringify({ listPath: values["list-path"], sites: ranked.slice(0, 30) }));
  }
  let responseHash: string | undefined;
  if (values.mode === "equivalence") {
    assert.ok(projection && listSessions && values["freeze-clock"]);
    const frames: string[] = [];
    const randomUUID = crypto.randomUUID;
    let revision = 0;
    crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${(++revision).toString(16).padStart(12, "0")}`;
    syncBuiltinESMExports();
    try {
      for (const rowMode of [undefined, "compact", "sidebar", "dashboard"] as const) {
        for (const archived of [false, true, "all"] as const) {
          const payload = await listSessions({
            projection,
            acceptsSerializedJson: true,
            opts: { rowMode, archived, agentId: "main", limit: 100 },
          });
          frames.push(
            serializeGatewayFrame({ type: "res", id: "list", ok: true, payload }).toString(),
          );
        }
      }
    } finally {
      crypto.randomUUID = randomUUID;
      syncBuiltinESMExports();
    }
    const bytes = JSON.stringify(frames);
    writeFileSync(path.join(root, "responses.json"), bytes);
    responseHash = createHash("sha256").update(bytes).digest("hex");
  }
  const gc: Record<string, { count: number; totalMs: number }> = {};
  for (const entry of gcEntries) {
    if (entry.at < started || entry.at >= ended) {
      continue;
    }
    const name =
      entry.kind === constants.NODE_PERFORMANCE_GC_MINOR
        ? "minor"
        : entry.kind === constants.NODE_PERFORMANCE_GC_MAJOR
          ? "major"
          : "other";
    const metric = (gc[name] ??= { count: 0, totalMs: 0 });
    metric.count++;
    metric.totalMs += entry.duration;
  }
  collectGarbage();
  const result = {
    mode: values.mode,
    workload: values.workload,
    listPath: values["list-path"],
    serialized: values.serialized,
    frozenClock: values["freeze-clock"],
    responseHash,
    responseBytes,
    countersBefore,
    countersAfter,
    fixture: fixture?.summary,
    parentCount,
    childCount,
    registryRows: memory.subagentRuns.size,
    rows: rows.length,
    subagentRows: rows.filter(({ key }) => key.includes(":subagent:")).length,
    ...work,
    wallMs: ended - started,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    resolutionCpuMsPerList: work.resolutionCpuMicros / 1000 / work.lists,
    updateCpuMsPerUpdate: work.updateCpuMicros / 1000 / work.updates,
    ownerCpuMsPerList: values.workload === "owner" ? ownerCpuMicros / 1000 / work.lists : undefined,
    ownerReads,
    returnedRows,
    requesterRoots: requesterRoots.length,
    descendantQueryCountAvailable: values.workload === "owner",
    descendantQueries: values.workload === "owner" ? descendantQueries : undefined,
    descendantQueriesPerList:
      values.workload === "owner" ? descendantQueries / work.lists : undefined,
    descendantQueryCountSource:
      values.workload === "owner" ? "explicit owner-workload calls" : undefined,
    allocatedBytes,
    allocatedBytesPerList: allocatedBytes === undefined ? undefined : allocatedBytes / work.lists,
    ownerRegionAllocatedBytes,
    ownerRegionAllocatedBytesPerList:
      ownerRegionAllocatedBytes === undefined ? undefined : ownerRegionAllocatedBytes / work.lists,
    descendantRegionAllocatedBytes,
    descendantRegionAllocatedBytesPerList:
      descendantRegionAllocatedBytes === undefined
        ? undefined
        : descendantRegionAllocatedBytes / work.lists,
    ownerRegionEpochCount: sampleOwnerRegions ? allocationRegions.owner.length : undefined,
    descendantRegionEpochCount: sampleOwnerRegions
      ? allocationRegions.descendant.length
      : undefined,
    allocationRegionAttribution: sampleOwnerRegions
      ? "entire temporal regions including sampler boundary and caller overhead; owner includes argument spreads"
      : undefined,
    allocatedBytesPerUpdate:
      allocatedBytes === undefined ? undefined : allocatedBytes / work.updates,
    gc,
    topologyChanges,
    checksum,
    heapBefore,
    heapAfter,
    retainedHeapAfter: process.memoryUsage().heapUsed,
  };
  writeFileSync(
    path.join(root, `result${sample ? `-${sample}` : ""}.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  process.send?.({ sample, result });
}
try {
  await run(warmup);
  if (values.mode === "allocation" || values.mode === "census") {
    inspector.connect();
  }
  for (let sample = 0; sample < integer("samples"); sample++) {
    if (values.controlled) {
      const command = once(process, "message");
      process.send?.({ ready: sample });
      assert.equal((await command)[0], "measure");
    }
    await measure(sample);
  }
} finally {
  observer.disconnect();
  inspector.disconnect();
  resident?.dispose();
  projection?.dispose();
  releaseForeground?.();
  for (const [id, token] of claims) {
    registry.releaseAgentRunContext(id, token);
  }
  memory.subagentRuns.clear();
  if (fixture) {
    const { closeOpenClawAgentDatabasesAsync } =
      await import("../../src/state/openclaw-agent-db.js");
    const { closeOpenClawStateDatabaseAsync } =
      await import("../../src/state/openclaw-state-db.js");
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  }
  if (values.controlled) {
    process.disconnect?.();
  }
}
