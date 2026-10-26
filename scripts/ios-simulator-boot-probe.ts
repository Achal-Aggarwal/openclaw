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
import { gatewayEnv } from "./ios-release-e2e.js";
import { markIosResourcePhase } from "./ios-resource-timeline.mjs";
import { summarizeGatewayLogs } from "./lib/ios-release-e2e-diagnostics.js";
import { prepareIOSReleaseGateway } from "./lib/ios-release-gateway.js";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mjs";

const { values } = parseArgs({
  options: {
    "target-sha": { type: "string" },
    "gateway-selection": { type: "string" },
    output: { type: "string" },
  },
});
const targetSha = values["target-sha"];
const selectionDir = values["gateway-selection"];
const output = values.output;
if (!targetSha || !/^[a-f0-9]{40}$/u.test(targetSha) || !selectionDir || !output) {
  throw new Error("Required: --target-sha SHA --gateway-selection DIR --output FILE");
}
const abort = new AbortController();
const cancel = () => abort.abort();
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
const operations: Record<string, unknown>[] = [];
const snapshots: Record<string, unknown>[] = [];
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
let retainRoot = false;
const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-ios-boot-probe-"));
let instance: OpenClawTestInstance | undefined;
let udid: string | undefined;
let earlySnapshot: Promise<void> | undefined;
const snapshotAbort = new AbortController();
const host = () => ({
  load: os.loadavg(),
  cpuCount: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
});
const command = async (
  name: string,
  bin: string,
  args: string[],
  timeoutMs = 60_000,
  observe = false,
) => {
  const started = performance.now();
  let stdout = "";
  let outcome = "passed";
  if (!observe) {
    phase = name;
    markIosResourcePhase(`qualification-${name}`);
    console.error(`iOS boot probe: ${name} started`);
  }
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
    if (observe) {
      return stdout.trim();
    }
    throw error;
  } finally {
    operations.push({ name, outcome, ms: Math.round(performance.now() - started) });
    if (!observe) {
      console.error(`iOS boot probe: ${name} ${outcome}`);
    }
  }
};
const snapshot = async (stage: string) => {
  const started = performance.now();
  const before = host();
  // Two samples, without memory-map or framework scans; keep partial rows on timeout.
  const text = await command(
    "boot-process-snapshot",
    "/usr/bin/top",
    [
      "-l",
      "2",
      "-s",
      "1",
      "-n",
      "30",
      "-o",
      "cpu",
      "-R",
      "-F",
      "-stats",
      "pid,cpu,threads,pstate,time,command",
    ],
    8_000,
    true,
  );
  const rows = text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)(?:\/(\d+))?\s+([A-Za-z]+)\s+([\d:.]+)\s+.+$/u.exec(
      line,
    );
    if (!match) {
      return [];
    }
    const [, pid, cpu, threads, runningThreads, state, time] = match;
    return [
      {
        pid: Number(pid),
        cpuPercent: Number(cpu),
        threads: Number(threads),
        runningThreads: runningThreads ? Number(runningThreads) : 0,
        state: ["running", "sleeping", "stuck", "idle", "stopped", "zombie"].includes(state!)
          ? state
          : "other",
        cpuTime: time,
        role: "other",
        origin: "other",
      },
    ];
  });
  // Resolve only the selected PIDs. No arguments, environments, or raw paths leave this process.
  let paths: Record<string, string> = {};
  try {
    paths = JSON.parse(
      (await command(
        "boot-process-paths",
        "/usr/bin/python3",
        [
          "-c",
          "import ctypes,json,sys\nlib=ctypes.CDLL('/usr/lib/libproc.dylib')\nrows={}\nfor pid in sys.argv[1:]:\n b=ctypes.create_string_buffer(4096)\n if lib.proc_pidpath(int(pid),b,len(b))>0: rows[pid]=b.value.decode('utf-8',errors='replace')\nprint(json.dumps(rows))",
          ...new Set(rows.map((row) => String(row.pid))),
        ],
        3_000,
        true,
      )) || "{}",
    );
  } catch {
    // A timed-out path observer must not discard the process/thread snapshot.
  }
  for (const row of rows) {
    const executable = paths[row.pid] ?? "";
    const basename = path.basename(executable);
    const runtime =
      (executable.startsWith("/Library/Developer/CoreSimulator/") ||
        executable.startsWith(
          "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-",
        )) &&
      executable.includes("/Contents/Resources/RuntimeRoot/");
    const publicSystem = /^\/(?:System\/Library|usr\/(?:bin|sbin|libexec)|bin|sbin)\//u.test(
      executable,
    );
    const runtimeSystem =
      /\/Contents\/Resources\/RuntimeRoot\/(?:System\/Library|usr\/(?:bin|sbin|libexec))\//u.test(
        executable,
      );
    if (
      (publicSystem || (runtime && runtimeSystem)) &&
      path.posix.normalize(executable) === executable &&
      /^[A-Za-z][A-Za-z0-9_.+-]{0,95}$/u.test(basename)
    ) {
      row.role = basename;
      row.origin = runtime ? "simulator-runtime" : "host-system";
    } else if (row.pid === instance?.child?.pid) {
      row.role = "gateway";
    }
  }
  snapshots.push({
    stage,
    at: new Date().toISOString(),
    ms: Math.round(performance.now() - started),
    before,
    after: host(),
    rows,
  });
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
      outcome,
      ms: Math.round(performance.now() - started),
      authenticatedMs,
      dispatchedMs,
      host: host(),
    });
    console.error(`iOS boot probe: ${stage} ${outcome}`);
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
  await snapshot("before-boot");
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
  earlySnapshot = sleep(5_000, undefined, { signal: snapshotAbort.signal })
    .then(
      () => snapshot("boot-plus-5s"),
      () => {},
    )
    .catch(() => {
      snapshots.push({ stage: "boot-plus-5s", outcome: "unavailable" });
    });
  await command("simulator-boot", "xcrun", ["simctl", "boot", udid]);
  await command("simulator-ready", "xcrun", ["simctl", "bootstatus", udid, "-b"], 180_000);
  await earlySnapshot;
  await rpc("after-boot-setup-status");
  await rpc("after-boot-setup-code", true);
  proof.status = "probe-passed";
} catch (error) {
  if (hasUnjoinedWork(error)) {
    retainRoot = true;
  }
  proof.failedPhase = phase;
  proof.status = "failed";
} finally {
  snapshotAbort.abort();
  await earlySnapshot;
  if (instance) {
    proof.gatewayEvents = summarizeGatewayLogs(instance.logs());
  }
  const cleanup = await Promise.allSettled([
    instance?.cleanup(),
    udid
      ? command("simulator-delete", "xcrun", ["simctl", "delete", udid], 60_000)
      : Promise.resolve(),
  ]);
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
