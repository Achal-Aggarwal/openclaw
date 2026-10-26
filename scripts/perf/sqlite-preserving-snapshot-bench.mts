/**
 * Artifact-preserving SQLite snapshot benchmark, using synthetic data only.
 *
 * Create an empty source directory (on btrfs, set chattr +C before generation):
 *   node --import ./scripts/tsx.mjs scripts/perf/sqlite-preserving-snapshot-bench.mts fixture <directory>
 * Then run each revision serially, alternating AB/BA over five cold and five warm
 * pairs, with the same fixture and an empty private staging directory:
 *   node --import ./scripts/tsx.mjs scripts/perf/sqlite-preserving-snapshot-bench.mts measure <directory> <staging>
 * Add --verify for source-family and accepted-snapshot hashes (outside timing),
 * or --alloc for a separate sampled-JavaScript-allocation pass. Do not mix sampled
 * allocation timings with untraced timings. External Buffer allocation is not
 * included in V8 allocation samples. The fixture is 2 GiB main + 500 MiB WAL.
 * Cold-cache control is external: evict only these fixture files and verify their
 * residency; never purge the host cache. Warm both source files before warm runs.
 */
import assert from "node:assert/strict";
import { createHash, randomFillSync } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../../src/infra/sqlite-readonly-location.js";

const [command, input, stagingInput, ...flags] = process.argv.slice(2);
assert(input, "fixture or measure requires a synthetic fixture directory");
const directory = path.resolve(input);
const source = path.join(directory, "source.sqlite");
const marker = path.join(directory, "synthetic-snapshot-benchmark");
const family = ["", "-wal", "-shm"];

function fingerprint() {
  return family.map((suffix) => {
    const stat = fs.statSync(source + suffix, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  });
}

function hashFile(filename: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filename, "r");
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) {
        return hash.digest("hex");
      }
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

if (command === "fixture") {
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(fs.readdirSync(directory).length, 0, "fixture directory must be empty");
  fs.writeFileSync(marker, "Synthetic SQLite benchmark; contains no operator data.\n");
  const creating = path.join(directory, "creating.sqlite");
  const database = new DatabaseSync(creating);
  try {
    database.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192;
      CREATE TABLE padding(id INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE config_health_entries(config_path TEXT PRIMARY KEY,
        last_known_good_json TEXT, last_promoted_good_json TEXT,
        last_observed_suspicious_signature TEXT, updated_at_ms INTEGER);
      INSERT INTO config_health_entries VALUES('/synthetic/openclaw.json','base',NULL,NULL,1);
      BEGIN`);
    const blob = randomFillSync(Buffer.alloc(1024 * 1024));
    const insert = database.prepare("INSERT INTO padding VALUES(?,?)");
    for (let index = 0; index < 2046; index++) {
      insert.run(index, blob);
    }
    database.exec("COMMIT; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN");
    randomFillSync(blob);
    const update = database.prepare("UPDATE padding SET data=? WHERE id=?");
    for (let index = 0; index < 497; index++) {
      update.run(blob, index);
    }
    database.exec(
      "UPDATE config_health_entries SET last_known_good_json='wal',updated_at_ms=2; COMMIT",
    );
    for (const suffix of family) {
      fs.copyFileSync(creating + suffix, source + suffix, fs.constants.COPYFILE_FICLONE);
    }
  } finally {
    database.close();
    fs.rmSync(creating, { force: true });
  }
  console.log(JSON.stringify({ bytes: family.map((suffix) => fs.statSync(source + suffix).size) }));
} else if (command === "measure") {
  assert(fs.existsSync(marker), "only benchmark-created synthetic fixtures are accepted");
  assert(stagingInput, "measure requires a private staging directory");
  const staging = path.resolve(stagingInput);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const stagingBefore = fs.readdirSync(staging);
  const before = fingerprint();
  const verify = flags.includes("--verify");
  const sourceHashes = verify ? family.map((suffix) => hashFile(source + suffix)) : undefined;
  const inspector = flags.includes("--alloc") ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(source, staging);
  const prepareMs = performance.now() - start;
  let result;
  try {
    const snapshotHashes = verify
      ? [hashFile(prepared.location), hashFile(prepared.location + "-wal")]
      : undefined;
    const openStart = performance.now();
    const database = new DatabaseSync(prepared.location, { readOnly: true });
    const openMs = performance.now() - openStart;
    let queryMs: number;
    try {
      const queryStart = performance.now();
      const row = database
        .prepare(`SELECT config_path,last_known_good_json,last_promoted_good_json,
        last_observed_suspicious_signature,updated_at_ms FROM config_health_entries
        ORDER BY config_path ASC`)
        .get();
      queryMs = performance.now() - queryStart;
      assert.equal(row?.updated_at_ms, 2, "the WAL-only committed health row must survive");
    } finally {
      database.close();
    }
    const cpuUsed = process.cpuUsage(cpu);
    let sampledJsBytes: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledJsBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    result = {
      platform: process.platform,
      node: process.version,
      hostLoad,
      prepareMs,
      openMs,
      queryMs,
      cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
      memory: process.memoryUsage(),
      sampledJsBytes,
      sourceHashes,
      snapshotHashes,
      timingIncludesHashing: verify,
    };
  } finally {
    inspector?.disconnect();
    prepared.cleanup?.();
  }
  assert.deepEqual(fingerprint(), before, "source family metadata changed");
  if (verify) {
    assert.deepEqual(
      family.map((suffix) => hashFile(source + suffix)),
      sourceHashes,
      "source bytes changed",
    );
  }
  assert.deepEqual(fs.readdirSync(staging), stagingBefore, "snapshot staging leaked");
  console.log(JSON.stringify(result));
} else {
  throw new Error("expected fixture or measure command");
}
