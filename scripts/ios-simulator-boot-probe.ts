// Temporary nonpublishing investigation; remove after the simulator startup incident is resolved.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { callGateway } from "../src/gateway/call.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../test/helpers/openclaw-test-instance.js";
import { gatewayEnv, operationError } from "./ios-release-e2e.js";
import { markIosResourcePhase, roles } from "./ios-resource-timeline.mjs";
import { summarizeGatewayLogs } from "./lib/ios-release-e2e-diagnostics.js";
import { prepareIOSReleaseGateway } from "./lib/ios-release-gateway.js";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mjs";

const { values } = parseArgs({
  options: {
    "target-sha": { type: "string" },
    "gateway-selection": { type: "string" },
    output: { type: "string" },
    collector: { type: "string" },
  },
});
const targetSha = values["target-sha"];
const selectionDir = values["gateway-selection"];
const output = values.output;
const collector = values.collector;
if (!targetSha || !/^[a-f0-9]{40}$/u.test(targetSha) || !selectionDir || !output || !collector) {
  throw new Error(
    "Required: --target-sha SHA --gateway-selection DIR --output FILE --collector PATH",
  );
}
const abort = new AbortController();
const cancel = () => abort.abort();
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
const operations: Record<string, unknown>[] = [];
const snapshots: Record<string, unknown>[] = [];
let runtimeLabels = new Map<string, string>();
const proof: Record<string, unknown> = {
  schema: 1,
  kind: "simulator-boot-probe",
  targetSha,
  harnessSha: targetSha,
  status: "failed",
  operations,
  snapshots,
  tests: [],
};
let phase = "startup";
let bootCycle: "cold" | "warm" = "cold";
let retainRoot = false;
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-ios-boot-probe-"));
let instance: OpenClawTestInstance | undefined;
let udid: string | undefined;
let observerDone: Promise<void> | undefined;
const observerAbort = new AbortController();
const host = () => ({
  load: os.loadavg(),
  cpuCount: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
});
const command = async (name: string, bin: string, args: string[], timeoutMs = 60_000) => {
  const started = performance.now();
  let stdout = "";
  let outcome = "passed";
  phase = name;
  markIosResourcePhase(`qualification-${name}`);
  console.error(`iOS boot probe: ${name} started`);
  try {
    const code = await runManagedCommand({
      bin,
      args,
      timeoutMs,
      requireProcessTreeExit: true,
      signal: name === "simulator-delete" ? undefined : abort.signal,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
        });
        child.stderr?.resume();
      },
    });
    if (code !== 0) {
      throw new Error("command-exit");
    }
    return stdout.trim();
  } catch (error) {
    outcome = "failed";
    if (hasUnjoinedWork(error)) {
      retainRoot = true;
    }
    throw error;
  } finally {
    operations.push({ name, bootCycle, outcome, ms: Math.round(performance.now() - started) });
    console.error(`iOS boot probe: ${name} ${outcome}`);
  }
};
type CensusRow = {
  pid: number;
  parentPid: number;
  birthSec: number;
  birthUsec: number;
  roleHint: string;
  labelHint?: string;
  userNs?: number;
  systemNs?: number;
  threads?: number;
  runningThreads?: number;
};
type BootSnapshot = {
  stage: string;
  receivedAtMs: number;
  bootCycle: "cold" | "warm";
  sample: number;
  startedMs: number;
  endedMs?: number;
  pendingPid?: number;
  hostBefore: ReturnType<typeof host>;
  hostAfter?: ReturnType<typeof host>;
  rows: CensusRow[];
};
const collectCensus = async (stage: "before-boot" | "after-headroom") => {
  phase = `census-${stage}`;
  const cycle = bootCycle;
  const hints = new Map<string, string>();
  for (const role of roles) {
    const short = role.slice(0, 16);
    hints.set(short, hints.has(short) ? "other" : role);
  }
  let baselineSeen = false;
  let observerPassed = false;
  let ready!: () => void;
  const baseline = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let buffer = "";
  let active: BootSnapshot | undefined;
  let byPid = new Map<number, CensusRow>();
  let labelHints = new Map<number, string>();
  let bytes = 0;
  const observeLine = (line: string) => {
    const fields = line.split("\t");
    if (fields[0] === "BEGIN") {
      active = {
        stage,
        receivedAtMs: Date.now(),
        bootCycle: cycle,
        sample: Number(fields[1]),
        startedMs: Number(fields[2]),
        hostBefore: host(),
        rows: [],
      };
      snapshots.push(active);
      byPid = new Map();
      labelHints = new Map();
    } else if (active && fields[0] === "CENSUS") {
      const row: CensusRow = {
        pid: Number(fields[1]),
        parentPid: Number(fields[2]),
        birthSec: Number(fields[3]),
        birthUsec: Number(fields[4]),
        roleHint: hints.get(fields[5] ?? "") ?? "other",
      };
      active.rows.push(row);
      byPid.set(row.pid, row);
      const label = runtimeLabels.get(fields[5] ?? "");
      if (label) {
        labelHints.set(row.pid, label);
      }
    } else if (active && fields[0] === "CENSUS_END") {
      // Restrict public runtime metadata hints to direct simulator launchd children.
      for (const row of active.rows) {
        const label = labelHints.get(row.pid);
        if (label && byPid.get(row.parentPid)?.roleHint === "launchd_sim") {
          row.labelHint = label;
        }
      }
      labelHints.clear();
    } else if (active && fields[0] === "QUERY") {
      active.pendingPid = Number(fields[1]);
    } else if (active && fields[0] === "TASK") {
      const row = byPid.get(Number(fields[1]));
      if (row) {
        row.userNs = Number(fields[2]);
        row.systemNs = Number(fields[3]);
        row.threads = Number(fields[4]);
        row.runningThreads = Number(fields[5]);
      }
    } else if (active && fields[0] === "END") {
      active.endedMs = Number(fields[2]);
      active.hostAfter = host();
      delete active.pendingPid;
      if (active.sample === 0) {
        baselineSeen = true;
        ready();
      }
    }
  };
  const started = performance.now();
  observerDone = runManagedCommand({
    bin: collector,
    args: [],
    timeoutMs: 65_000,
    requireProcessTreeExit: true,
    signal: AbortSignal.any([abort.signal, observerAbort.signal]),
    stdio: ["ignore", "pipe", "pipe"],
    onReady(child) {
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          observerAbort.abort();
          return;
        }
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          observeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      child.stderr?.resume();
    },
  }).then(
    (code) => {
      observerPassed = code === 0;
      operations.push({
        name: "boot-census",
        stage,
        bootCycle: cycle,
        outcome: code === 0 ? "passed" : "failed",
        ms: Math.round(performance.now() - started),
      });
      ready();
    },
    (error: unknown) => {
      if (hasUnjoinedWork(error)) {
        retainRoot = true;
      }
      operations.push({
        name: "boot-census",
        stage,
        bootCycle: cycle,
        outcome: "failed",
        ms: Math.round(performance.now() - started),
      });
      ready();
    },
  );
  const readinessAbort = new AbortController();
  try {
    await Promise.race([baseline, sleep(15_000, undefined, { signal: readinessAbort.signal })]);
    if (!baselineSeen) {
      throw new Error("observer-baseline-unavailable");
    }
    await observerDone;
    if (!observerPassed) {
      throw new Error("observer-failed");
    }
  } finally {
    readinessAbort.abort();
  }
};
const rpc = async (stage: string, setupCode = false) => {
  if (!instance) {
    throw new Error("fixture-unavailable");
  }
  phase = stage;
  markIosResourcePhase(setupCode ? "qualification-setup-code" : "qualification-setup-status");
  const started = performance.now();
  let authenticatedMs: number | undefined;
  let dispatchedMs: number | undefined;
  let outcome = "failed";
  try {
    await callGateway({
      config: {},
      configPath: instance.configPath,
      url: instance.url,
      token: instance.gatewayToken,
      ignoreEnvUrlOverride: true,
      deviceIdentity: null,
      sharedStateMode: "read-only",
      method: setupCode ? "device.pair.setupCode" : "device.pair.setupStatus",
      params: setupCode ? { publicUrl: instance.url, includeQr: false } : { setupId: randomUUID() },
      timeoutMs: setupCode ? 60_000 : 30_000,
      signal: abort.signal,
      onHelloOk: () => {
        authenticatedMs = Math.round(performance.now() - started);
      },
      assertDispatchCurrent: () => {
        abort.signal.throwIfAborted();
        dispatchedMs = Math.round(performance.now() - started);
      },
    });
    outcome = "passed";
  } finally {
    operations.push({
      name: stage,
      bootCycle,
      outcome,
      ms: Math.round(performance.now() - started),
      authenticatedMs,
      dispatchedMs,
      host: host(),
    });
    console.error(`iOS boot probe: ${stage} ${outcome}`);
  }
};
const waitForCpuHeadroom = async () => {
  phase = "host-headroom";
  const started = performance.now();
  const samples: Record<string, number>[] = [];
  const evidence = { outcome: "failed", elapsedMs: 0, samples };
  proof.headroom = evidence;
  const cpuTimes = () =>
    os.cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
      }),
      { idle: 0, total: 0 },
    );
  let previous = cpuTimes();
  let previousAt = performance.now();
  let quietSamples = 0;
  console.error("iOS boot probe: waiting for sustained CPU headroom");
  try {
    while (performance.now() - started < 300_000) {
      await sleep(Math.min(2000, 300_000 - (performance.now() - started)), undefined, {
        signal: abort.signal,
      });
      const now = performance.now();
      const current = cpuTimes();
      const idlePercent = (100 * (current.idle - previous.idle)) / (current.total - previous.total);
      const intervalMs = now - previousAt;
      samples.push({
        atMs: Math.round(now - started),
        intervalMs: Math.round(intervalMs),
        idlePercent: Math.round(idlePercent * 100) / 100,
      });
      quietSamples = idlePercent >= 30 && intervalMs <= 4000 ? quietSamples + 1 : 0;
      if (quietSamples >= 5) {
        evidence.outcome = "passed";
        return;
      }
      previous = current;
      previousAt = now;
    }
    throw new Error("host-headroom-unavailable");
  } finally {
    evidence.elapsedMs = Math.round(performance.now() - started);
    console.error(`iOS boot probe: CPU headroom ${evidence.outcome}`);
  }
};
try {
  if ((await command("source-head", "git", ["rev-parse", "HEAD"])) !== targetSha) {
    throw new Error("source-mismatch");
  }
  if (
    await command("source-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"])
  ) {
    throw new Error("source-dirty");
  }
  proof.xcode = await command("xcode-version", "xcodebuild", ["-version"]);
  const { runtimes } = JSON.parse(
    await command("simulator-runtime", "xcrun", ["simctl", "list", "runtimes", "--json"]),
  );
  const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
  const runtime = runtimes
    .filter(
      (row: {
        isAvailable: boolean;
        identifier: string;
        supportedArchitectures: string[];
        supportedDeviceTypes: { identifier: string }[];
      }) =>
        row.isAvailable &&
        row.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        row.supportedArchitectures.includes(process.arch) &&
        row.supportedDeviceTypes.some((device) => device.identifier === deviceType),
    )
    .toSorted((a: { version: string }, b: { version: string }) =>
      b.version.localeCompare(a.version, "en", { numeric: true }),
    )[0];
  if (!runtime) {
    throw new Error("runtime-missing");
  }
  proof.runtime = runtime.identifier;
  if (typeof runtime.runtimeRoot !== "string" || !path.isAbsolute(runtime.runtimeRoot)) {
    throw new Error("runtime-root-missing");
  }
  runtimeLabels = new Map(
    JSON.parse(
      await command("runtime-job-labels", "python3", [
        "-c",
        `import json, pathlib, plistlib, re, sys
from collections import defaultdict
root = pathlib.Path(sys.argv[1])
buckets = defaultdict(set)
for directory in ("System/Library/LaunchDaemons", "System/Library/LaunchAgents"):
    for file in (root / directory).glob("*.plist"):
        data = plistlib.loads(file.read_bytes())
        args = data.get("ProgramArguments") or []
        program = data.get("Program") or (args[0] if args else "")
        label = data.get("Label", "")
        name = pathlib.PurePosixPath(program).name
        if re.fullmatch(r"[A-Za-z0-9_.+-]{1,160}", name) and re.fullmatch(r"com\\.apple\\.[A-Za-z0-9_.-]{1,120}", label):
            buckets[name[:16]].add(label)
print(json.dumps([[name, next(iter(labels))] for name, labels in buckets.items() if len(labels) == 1]))`,
        runtime.runtimeRoot,
      ]),
    ),
  );
  proof.runtimeLabelHintCount = runtimeLabels.size;
  phase = "gateway-install";
  const gateway = await prepareIOSReleaseGateway({
    targetSha,
    selectionDir,
    installDir: path.join(root, "gateway"),
    signal: abort.signal,
  });
  proof.gateway = gateway.identity;
  phase = "gateway-start";
  instance = await createOpenClawTestInstance({
    name: "ios-simulator-boot-probe",
    cwd: gateway.cwd,
    entrypoint: gateway.entrypoint,
    config: { gateway: { controlUi: { enabled: false } } },
    env: gatewayEnv,
    signal: abort.signal,
  });
  await instance.startGateway();
  await rpc("before-boot-setup-status");
  udid = await command("simulator-create", "xcrun", [
    "simctl",
    "create",
    "openclaw-ios-boot-probe",
    deviceType,
    runtime.identifier,
  ]);
  if (!/^[A-F0-9-]{36}$/u.test(udid)) {
    udid = undefined;
    throw new Error("invalid-device-id");
  }
  for (const cycle of ["cold"] as const) {
    bootCycle = cycle;
    await collectCensus("before-boot");
    await command("simulator-boot", "xcrun", ["simctl", "boot", udid]);
    await command("simulator-ready", "xcrun", ["simctl", "bootstatus", udid, "-b"], 180_000);
    let headroomFailure: unknown;
    try {
      await waitForCpuHeadroom();
    } catch (error) {
      headroomFailure = error;
    }
    await collectCensus("after-headroom");
    if (headroomFailure) {
      phase = "host-headroom";
      throw new Error("host-headroom-unavailable", { cause: headroomFailure });
    }
    await rpc("after-boot-setup-status");
    await rpc("after-boot-setup-code", true);
    await observerDone;
    if (retainRoot) {
      throw new Error("observer-cleanup-unconfirmed");
    }
    await command("simulator-shutdown", "xcrun", ["simctl", "shutdown", udid]);
  }
  proof.status = "probe-passed";
} catch (error) {
  if (hasUnjoinedWork(error)) {
    retainRoot = true;
  }
  proof.failedPhase = phase;
  proof.failedBootCycle = bootCycle;
  proof.status = "failed";
} finally {
  if (proof.status !== "probe-passed") {
    observerAbort.abort();
  }
  await observerDone;
  // Retire the task-owned simulator's load before stopping the Gateway fixture.
  const cleanup = [
    ...(await Promise.allSettled([
      udid
        ? command("simulator-delete", "xcrun", ["simctl", "delete", udid], 60_000)
        : Promise.resolve(),
    ])),
    ...(await Promise.allSettled([instance?.cleanup()])),
  ];
  proof.cleanupFailures = cleanup.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            source: index === 0 ? "simulator" : "gateway",
            code: operationError("cleanup", result.reason).diagnostic.code,
            events: summarizeGatewayLogs(
              `${instance?.logs() ?? ""}\n${result.reason instanceof Error ? result.reason.message : ""}`,
            ),
          },
        ]
      : [],
  );
  if (instance) {
    proof.gatewayEvents = summarizeGatewayLogs(instance.logs());
  }
  proof.cleanupConfirmed = cleanup.every((result) => result.status === "fulfilled") && !retainRoot;
  if (!proof.cleanupConfirmed) {
    proof.status = "failed";
  }
  if (proof.cleanupConfirmed) {
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  process.off("SIGTERM", cancel);
  process.off("SIGINT", cancel);
}
process.exitCode = proof.status === "probe-passed" ? 0 : 1;
