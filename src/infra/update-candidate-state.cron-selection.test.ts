import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCronStoreSelectionInDatabase } from "../cron/store/paths.js";
import { readCronDefaultStoreBindingInDatabase } from "../state/openclaw-state-db-cron-identity-migration.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import {
  materializeUpdateCandidateStateWorker,
  runUpdateCandidateSnapshotWorker,
} from "./update-candidate-state.test-support.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(version: number, configOnly: boolean) {
  const root = await fs.realpath(dirs.make("candidate-cron-selection-"));
  const stateDir = path.join(root, ".openclaw");
  const candidateRoot = path.join(root, "candidate");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const configPath = path.join(root, "external-config", "openclaw.json");
  const physicalKey = path.join(stateDir, "cron", "jobs.json");
  const configKey = path.join(path.dirname(configPath), "cron", "jobs.json");
  const rows = [
    { store_key: physicalKey, job_id: "physical", job_json: '{"name":"physical partition"}' },
    { store_key: configKey, job_id: "external", job_json: '{"name":"external partition"}' },
  ];
  await fs.mkdir(path.dirname(shared), { recursive: true });
  {
    using db = openNodeSqliteDatabase(shared);
    db.exec(`PRAGMA user_version=${version};
      CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, job_json TEXT,
        PRIMARY KEY (store_key, job_id));`);
    for (const row of rows) {
      db.prepare("INSERT INTO cron_jobs VALUES (?, ?, ?)").run(
        row.store_key,
        row.job_id,
        row.job_json,
      );
    }
  }
  await materializeUpdateCandidateStateWorker(candidateRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: configOnly ? undefined : stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    TMPDIR: root,
  };
  return { root, stateDir, candidateRoot, shared, env, rows, physicalKey, configKey };
}

it.each([
  { version: 33, configOnly: false },
  { version: 33, configOnly: true },
  { version: 7, configOnly: true },
])("preserves the original v$version selector (config-only: $configOnly)", async (options) => {
  const source = await fixture(options.version, options.configOnly);
  const before = await fs.readFile(source.shared);
  const entries = await fs.readdir(path.dirname(source.shared));
  const expectedKey = options.configOnly ? source.configKey : source.physicalKey;
  const snapshot = await prepareUpdateCandidateStateSnapshot({
    config: {},
    stateDir: source.stateDir,
    candidateRoot: source.candidateRoot,
    env: source.env,
    workerEnv: (directory) => {
      // The launch owner must retain selection before this awaited isolation step.
      Object.assign(source.env, buildUpdateRehearsalPathEnv(directory));
      return { ...source.env };
    },
  });
  try {
    using copy = openNodeSqliteDatabase(path.join(snapshot.stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    expect(readCronDefaultStoreBindingInDatabase(copy)).toEqual({
      status: "ready",
      storeKey: expectedKey,
    });
    expect(
      resolveCronStoreSelectionInDatabase(
        copy,
        undefined,
        buildUpdateRehearsalPathEnv(snapshot.stateDir),
      ),
    ).toEqual({
      status: "ready",
      storeKey: expectedKey,
      storePath: path.join(snapshot.stateDir, "cron", "jobs.json"),
    });
    expect(copy.prepare("SELECT * FROM cron_jobs ORDER BY store_key").all()).toEqual(source.rows);
    expect(copy.prepare("PRAGMA user_version").get()).toEqual({ user_version: options.version });
    expect(await fs.readdir(path.dirname(source.shared))).toEqual(entries);
    expect((await fs.readFile(source.shared)).equals(before)).toBe(true);
  } finally {
    for (const directory of snapshot.cleanupDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

it("keeps an older driver's omitted original selector unresolved", async () => {
  const source = await fixture(33, true);
  const targetStateDir = path.join(source.root, "legacy-copy");
  const before = await fs.readFile(source.shared);
  await runUpdateCandidateSnapshotWorker({
    config: {},
    stateDir: source.stateDir,
    candidateRoot: source.candidateRoot,
    targetStateDir,
    env: source.env,
  });
  using copy = openNodeSqliteDatabase(path.join(targetStateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  expect(readCronDefaultStoreBindingInDatabase(copy)).toEqual({ status: "absent" });
  expect(
    resolveCronStoreSelectionInDatabase(
      copy,
      undefined,
      buildUpdateRehearsalPathEnv(targetStateDir),
    ),
  ).toMatchObject({ status: "unresolved" });
  expect(copy.prepare("SELECT * FROM cron_jobs ORDER BY store_key").all()).toEqual(source.rows);
  expect((await fs.readFile(source.shared)).equals(before)).toBe(true);
});
