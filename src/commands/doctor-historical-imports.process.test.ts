import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import {
  preparation,
  original,
  stateV22Schema,
  stateV21Schema,
  seedHistoricalPlacements,
} from "../state/openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const childTimeout = 90_000;

it.each([21, 22])(
  "doctor imports historical shared-v%s and agent-v24 evidence through CLI Doctor",
  async (version) => {
    const port = await acquireTestPortBlock({ offsets: [0] });
    onTestFinished(port.release);
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        gateway: { mode: "local", port: port.port, controlUi: { enabled: false } },
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      let beforePlacements: Record<string, SQLOutputValue>[] = [];
      let beforeEnvironment: Record<string, SQLOutputValue>;
      {
        using db = new DatabaseSync(sharedPath);
        db.exec(version === 21 ? stateV21Schema() : stateV22Schema());
        db.exec(
          "PRAGMA user_version=" +
            version +
            "; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global'," +
            version +
            ",1,1);",
        );
        db.prepare(
          "INSERT INTO worker_environments " +
            "(environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,lease_id," +
            "preparation_key,preparation_purpose,preparation_demand_at_ms,preparation_expires_at_ms," +
            "preparation_consumed_at_ms,state,owner_epoch,attached_session_ids_json," +
            "created_at_ms,updated_at_ms,state_changed_at_ms,destroy_requested_at_ms) " +
            "VALUES ('historical-image','synthetic','sandbox',?,'provision-image','lease-image'," +
            "?,'reserve',1000,2000,1500,'destroyed',7,'[]',1,2,2,2)",
        ).run(original, preparation.key);
        if (version === 21) {
          beforePlacements = seedHistoricalPlacements(db);
        }
        beforeEnvironment = db.prepare("SELECT * FROM worker_environments").get()!;
      }
      const agentPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      let beforeInputs: Record<string, SQLOutputValue>[];
      {
        using db = new DatabaseSync(agentPath);
        db.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
        db.exec(
          "ALTER TABLE session_pending_inputs ADD COLUMN recovery_intent_json TEXT; PRAGMA user_version=24;" +
            "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES ('primary','agent',24,'main',1,1);" +
            "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES ('agent:main:history','sid-1','{\"sessionId\":\"sid-1\",\"updatedAt\":1}',1);" +
            "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES ('sid-1','agent:main:history',1,1);",
        );
        for (const status of ["queued", "interrupted", "cancelled"]) {
          db.prepare(
            "INSERT INTO session_pending_inputs " +
              "(input_id,session_key,session_id,idempotency_key,run_id,request_hash,message_json,lifecycle_generation,state,accepted_at,recovery_intent_json) " +
              "VALUES (?, 'agent:main:history','sid-1',?,?,'hash',?,'historical-generation',?,1,?)",
          ).run(
            status,
            status,
            "run-" + status,
            JSON.stringify({ role: "user", content: "Retain " + status }),
            status,
            '{"historical":"evidence-only"}',
          );
        }
        beforeInputs = db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all();
      }
      const runtime = createSourceRuntime(state.root);
      const env: NodeJS.ProcessEnv = {
        ...state.env,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_NO_RESPAWN: "1",
        NO_COLOR: "1",
      };
      for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
        delete env[key];
      }
      {
        const result = await runSourceRuntime(
          runtime,
          env,
          [
            "--input-type=module",
            "--eval",
            [
              'import { registerHooks } from "node:module";',
              'import path from "node:path";',
              "registerHooks({ resolve(specifier, context, nextResolve) {",
              'if (specifier.endsWith("/doctor-health-contributions.js")) {',
              'return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(',
              '"export async function runDoctorHealthContributions() {}\\n" +',
              '"export async function resolveDoctorContributionHealthChecks() { return []; }") };',
              "}",
              "return nextResolve(specifier, context);",
              "}});",
              'process.argv = [process.execPath,path.resolve("src/entry.ts"),"doctor","--fix","--non-interactive","--no-workspace-suggestions"];',
              'await import("./src/entry.ts");',
            ].join("\n"),
          ],
          childTimeout,
        );
        const output = result.stdout + "\n" + result.stderr;
        expect(result.code, output).toBe(0);
        expect(output).toContain("Doctor complete.");
        using db = new DatabaseSync(sharedPath, { readOnly: true });
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        const environment = db.prepare("SELECT * FROM worker_environments").get()!;
        expect(environment).toMatchObject({
          ...beforeEnvironment,
          profile_snapshot_json: expect.any(String),
        });
        expect(JSON.parse(String(environment.profile_snapshot_json))).toEqual({
          install: "bundle",
          settings: { provider: "synthetic" },
          runtimePreparation: { ...preparation, source: "empty" },
          historicalProfileSnapshotJson: original,
        });
        if (version === 21) {
          const placements = db
            .prepare("SELECT * FROM worker_session_placements ORDER BY session_id")
            .all();
          expect(placements).toHaveLength(beforePlacements.length);
          for (const [index, placement] of beforePlacements.entries()) {
            expect(placements[index]).toEqual(
              placement.repository_preparation === "pending"
                ? {
                    ...placement,
                    state: "failed",
                    recovery_error: expect.stringContaining(
                      "Historical repository preparation pending",
                    ),
                  }
                : placement,
            );
          }
        }
        using agent = new DatabaseSync(agentPath, { readOnly: true });
        expect(agent.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(agent.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
          beforeInputs.map((row) => ({
            ...row,
            state: row.state === "queued" ? "interrupted" : row.state,
            consumed_event_id: null,
          })),
        );
        expect(
          agent.prepare("SELECT * FROM session_pending_inputs WHERE state = 'queued'").all(),
        ).toEqual([]);
        expect(agent.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }
      for (const [pathname, sourceVersion] of [
        [sharedPath, version],
        [agentPath, 24],
      ] as const) {
        const backups = fs
          .readdirSync(path.dirname(pathname))
          .filter(
            (name) =>
              name.startsWith(path.basename(pathname) + ".pre-startup-migration-") &&
              name.endsWith(".bak") &&
              !name.endsWith(".scoped.bak"),
          );
        const originalBackup = backups.find((name) => {
          using saved = new DatabaseSync(path.join(path.dirname(pathname), name), {
            readOnly: true,
          });
          return saved.prepare("PRAGMA user_version").get()?.user_version === sourceVersion;
        });
        expect(originalBackup).toBeDefined();
        using saved = new DatabaseSync(path.join(path.dirname(pathname), originalBackup!), {
          readOnly: true,
        });
        if (sourceVersion === 24) {
          expect(saved.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
            beforeInputs,
          );
        } else {
          expect(
            saved.prepare("SELECT profile_snapshot_json FROM worker_environments").get(),
          ).toEqual({ profile_snapshot_json: original });
        }
      }
    });
  },
  getCliProcessTestTimeout(childTimeout),
);
