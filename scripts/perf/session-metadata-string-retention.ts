/**
 * Synthetic session-store-projection acceptance benchmark, Node 26 with --expose-gc.
 * Generate state with team-shape-fixture.ts, then capture its native worker reply:
 *   node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
 *     --state-dir <fixture> --gateway-preload <capture.mjs> <normal workload options>
 * Minimal capture.mjs (use an absolute output path; only run on generated fixtures):
 *   import { readFileSync, writeFileSync } from 'node:fs';
 *   import { serialize } from 'node:v8'; import { Worker, isMainThread } from 'node:worker_threads';
 *   if (isMainThread) {
 *     const manifest = JSON.parse(readFileSync(process.env.OPENCLAW_STATE_DIR + '/team-shape-summary.json'));
 *     if (manifest.format !== 'openclaw-team-shape-v1') throw Error('Synthetic fixture required');
 *     const emit = Worker.prototype.emit; let captured = false;
 *     Worker.prototype.emit = function(event, message, ...rest) {
 *       for (let value = message; event === 'message' && value && typeof value === 'object'; value = value.value) {
 *         if (!captured && value.kind === 'session-store-projection') {
 *           writeFileSync('/absolute/reply.bin', serialize(value)); captured = true;
 *         }
 *       }
 *       return emit.call(this, event, message, ...rest);
 *     };
 *   }
 * Replay the real reader owner, not a duplicate sharing implementation:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-metadata-string-retention.ts \
 *     --state-dir <fixture> --reply <reply.bin> --output .local/metadata-proof --mode all \
 *     --baseline <saved-baseline-session-transcript-worker-readers.ts>
 * --owner selects another candidate source. Baseline imports are rebased to the current
 * owner's directory in an output-only source copy. Modes: cpu, allocation, retained,
 * snapshot, all. Five counterbalanced samples; 5 replies/CPU sample, 2/profile.
 * Allocation includes collected objects. Snapshot uses the first 256 captured rows.
 * Inspect snapshots with scripts/heap-snapshot-diff.mjs --summary; metadataSnapshotOwner
 * labels identify baseline/candidate objects for physical string-node counting.
 * This measures post-transport acceptance; Gateway attribution must be established separately.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deserialize, serialize, writeHeapSnapshot } from "node:v8";
import type { SessionStoreProjectionWorkerResult as Reply } from "../../src/config/sessions/session-store-projection.types.js";
import { createSessionHistoryWorkerRequestStub } from "../../src/config/sessions/session-transcript-worker-readers.test-support.js";

type Factory =
  typeof import("../../src/config/sessions/session-transcript-worker-readers.js").createSessionHistoryWorkerReaders;
const canonicalOwner = path.resolve("src/config/sessions/session-transcript-worker-readers.ts");
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    reply: { type: "string" },
    output: { type: "string" },
    owner: { type: "string" },
    baseline: { type: "string" },
    mode: { type: "string", default: "cpu" },
  },
});
assert(
  values["state-dir"] && values.reply && values.output,
  "--state-dir, --reply and --output required",
);
assert(globalThis.gc, "Start Node with --expose-gc");
const manifest = JSON.parse(
  readFileSync(path.join(values["state-dir"], "team-shape-summary.json"), "utf8"),
);
assert.equal(manifest.format, "openclaw-team-shape-v1");
assert(["cpu", "allocation", "retained", "snapshot", "all"].includes(values.mode!));
mkdirSync(values.output, { recursive: true });
const output = (name: string) => path.join(values.output!, name);
const write = (name: string, value: unknown) =>
  writeFileSync(output(name), JSON.stringify(value, null, 2));
const bytes = readFileSync(values.reply);
// The fixture capture owns this private reply shape, just as the native transport does.
const fixture = deserialize(bytes) as Reply;
assert.equal(fixture.kind, "session-store-projection");
Reflect.set(globalThis, "metadataRetentionFixture", fixture);
const owners: Array<{ name: string; factory: Factory }> = [];
for (const [name, source] of [
  ["baseline", values.baseline],
  ["candidate", values.owner ?? canonicalOwner],
]) {
  if (!source) {
    continue;
  }
  let filename = path.resolve(source);
  if (name === "baseline") {
    const text = readFileSync(filename, "utf8").replace(
      /(from\s+["'])(\.[^"']+)/g,
      (_match, prefix: string, specifier: string) =>
        prefix + new URL(specifier, pathToFileURL(canonicalOwner)).href,
    );
    filename = output("baseline-owner.ts");
    writeFileSync(filename, text);
  }
  const module: { createSessionHistoryWorkerReaders: Factory } = await import(
    pathToFileURL(path.resolve(filename)).href
  );
  owners.push({ name: name!, factory: module.createSessionHistoryWorkerReaders });
}
function reader(factory: Factory, input: Uint8Array = bytes) {
  return factory(
    createSessionHistoryWorkerRequestStub(async (prepare) => {
      assert.equal(prepare().kind, "session-store-projection");
      return deserialize(input) as Reply;
    }),
  );
}
const request = { env: {}, expectedIdentity: { key: "file:synthetic" } };
let retained: Reply | undefined;
async function run(factory: Factory, count: number, input?: Uint8Array) {
  const owner = reader(factory, input);
  for (let index = 0; index < count; index++) {
    retained = await owner.readStoreProjection(request);
  }
}
for (const owner of owners) {
  await run(owner.factory, 1);
  assert.deepEqual(retained, fixture);
}
retained = undefined;
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
globalThis.gc();
globalThis.gc();
const selected = (mode: string) => values.mode === mode || values.mode === "all";
const samples: Array<Record<string, string | number>> = [];
for (let round = 0; round < 5; round++) {
  for (const owner of round % 2 ? owners.toReversed() : owners) {
    if (selected("cpu")) {
      await run(owner.factory, 1);
      retained = undefined;
      globalThis.gc();
      const start = process.cpuUsage();
      const wall = performance.now();
      await run(owner.factory, 5);
      const cpu = process.cpuUsage(start);
      samples.push({
        mode: "cpu",
        owner: owner.name,
        round,
        replies: 5,
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - wall,
      });
    }
    if (selected("allocation")) {
      retained = undefined;
      globalThis.gc();
      const inspector = new Session();
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await run(owner.factory, 2);
      globalThis.gc();
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      let size = 0;
      const pending = [profile.head];
      while (pending.length) {
        const node = pending.pop()!;
        size += node.selfSize;
        pending.push(...node.children);
      }
      write(`${owner.name}-${round}.heapprofile`, profile);
      samples.push({
        mode: "allocation",
        owner: owner.name,
        round,
        replies: 2,
        bytes: size,
        profileSamples: profile.samples.length,
      });
    }
    if (selected("retained")) {
      retained = undefined;
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      await run(owner.factory, 1);
      globalThis.gc();
      samples.push({
        mode: "retained",
        owner: owner.name,
        round,
        replies: 1,
        bytes: process.memoryUsage().heapUsed - before,
      });
    }
  }
}
// Keep the measured result observably live through the final forced collection.
assert(retained || selected("snapshot"));
write("results.json", {
  node: process.version,
  rows: fixture.entries.length,
  serializedBytes: bytes.length,
  equality: "passed",
  samples,
});
if (selected("snapshot")) {
  const snapshots: Reply[] = [];
  const input = serialize({ ...fixture, entries: fixture.entries.slice(0, 256) });
  for (const owner of owners) {
    await run(owner.factory, 1, input);
    assert(retained);
    for (const { entry } of retained.entries) {
      for (const object of [
        entry,
        entry.worktree,
        entry.createdActor,
        entry.owner?.actor,
        entry.owner?.assignedBy,
        ...(entry.participants ?? []).map((item) => item.identity),
      ]) {
        if (object) {
          Reflect.set(object, "metadataSnapshotOwner", owner.name);
        }
      }
    }
    snapshots.push(retained);
  }
  Reflect.set(globalThis, "metadataRetentionSnapshots", snapshots);
  globalThis.gc();
  writeHeapSnapshot(output("physical.heapsnapshot"));
}
console.log(
  JSON.stringify({ output: values.output, rows: fixture.entries.length, samples: samples.length }),
);
