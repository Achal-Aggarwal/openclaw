import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  seedHistoricalPlacements,
  stateV21Schema,
} from "./openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);
const source = ' { "accountId": "fixture-account", "channelId": "fixture-channel" } ';
const metadata = '{ "agentId": "main" }';
const policy = ' {"completionRetention":{"idPrefix":"keep:","maxAgeMs":86400000,"maxEntries":2}} ';

function fixture(refusal?: "claim" | "schema" | "publication") {
  const root = dirs.make("historical-placement-");
  const pathname = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(stateV21Schema());
  db.exec(
    "PRAGMA user_version=21; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',21,1,1);",
  );
  seedHistoricalPlacements(db);
  db.exec(
    "CREATE TABLE historical_cleanup_custody (session_id TEXT PRIMARY KEY REFERENCES worker_session_placements(session_id) ON DELETE CASCADE, evidence TEXT NOT NULL); INSERT INTO historical_cleanup_custody VALUES ('placement-pending',' {\"custody\": 7} ');",
  );
  db.exec(
    "INSERT INTO state_leases VALUES ('fixture','custody','fixture-owner',1900000000000,11,' {\"lease\": 7} ',1,2);" +
      "INSERT INTO user_profile_identities(provider,subject,profile_id,created_at,authorization_basis_json) VALUES ('fixture','101','profile',1,' {\"identity\": 7} ');" +
      "CREATE TRIGGER historical_placement_observer AFTER UPDATE OF recovery_error ON worker_session_placements BEGIN INSERT OR REPLACE INTO config_machine_state VALUES ('fixture.observed','true',1); END;",
  );
  db.prepare(
    "INSERT INTO meeting_transcript_sessions(session_id,started_at,selector,export_key,session_slug,provider_id,source_json,metadata_json,created_at_ms,updated_at_ms) VALUES ('meeting','2026-10-01','selector','export','slug','fixture',?,?,1,2)",
  ).run(source, metadata);
  db.exec(
    "INSERT INTO meeting_transcript_summaries(session_id,session_started_at,summary_json,utterance_count) VALUES ('meeting','2026-10-01',' {\"overview\":\"retained\"} ',0)",
  );
  db.prepare(
    "INSERT INTO delivery_queue_entries(queue_name,id,status,recovery_state,entry_json,enqueued_at,updated_at) VALUES ('fixture','keep:1','completed','completed_bounded',?,1,2)",
  ).run(policy);
  if (refusal === "claim") {
    db.exec(
      "UPDATE worker_session_placements SET turn_claim_owner='worker',turn_claim_id='pending-claim',turn_claim_run_id='pending-run',turn_claim_generation=7,turn_claim_owner_epoch=3 WHERE session_id='placement-pending'",
    );
  } else if (refusal === "schema") {
    db.exec(
      "ALTER TABLE worker_session_placements ADD COLUMN unknown_evidence TEXT; UPDATE worker_session_placements SET unknown_evidence='preserve'",
    );
  } else if (refusal === "publication") {
    db.exec(
      "CREATE TRIGGER refuse_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT,'fixture publication refusal'); END;",
    );
  }
  return { path: pathname, env: { OPENCLAW_STATE_DIR: root }, versionMigrationOnly: true };
}

function snapshot(db: DatabaseSync) {
  return {
    placements: db
      .prepare("SELECT rowid,* FROM worker_session_placements ORDER BY session_id")
      .all(),
    dependentCustody: db.prepare("SELECT * FROM historical_cleanup_custody").all(),
    leases: db.prepare("SELECT * FROM state_leases WHERE scope='fixture'").all(),
    identities: db.prepare("SELECT * FROM user_profile_identities").all(),
    meeting: db.prepare("SELECT source_json,metadata_json FROM meeting_transcript_sessions").all(),
    delivery: db.prepare("SELECT entry_json FROM delivery_queue_entries").all(),
    objects: db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE name IN ('historical_placement_epoch','historical_placement_observer') ORDER BY name",
      )
      .all(),
  };
}

it("preserves historical custody, sibling bytes, indexes and triggers while deriving v21 predicates", async () => {
  const options = fixture();
  await withStateMigrationBackupForTest(options, () => {
    using db = new DatabaseSync(options.path);
    const before = snapshot(db);
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    const after = snapshot(db);
    expect(after).toEqual({ ...before, placements: expect.any(Array) });
    expect(after.placements).toHaveLength(before.placements.length);
    for (const [index, row] of before.placements.entries()) {
      expect(after.placements[index]).toEqual(
        row.repository_preparation === "pending"
          ? {
              ...row,
              state: "failed",
              recovery_error: expect.stringContaining("Historical repository preparation pending"),
            }
          : row,
      );
    }
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    expect(
      db
        .prepare(
          "SELECT source_account_id,source_channel_id,metadata_agent_id FROM meeting_transcript_sessions",
        )
        .get(),
    ).toEqual({
      source_account_id: "fixture-account",
      source_channel_id: "fixture-channel",
      metadata_agent_id: "main",
    });
    expect(db.prepare("SELECT overview FROM meeting_transcript_summaries").get()).toEqual({
      overview: "retained",
    });
    expect(
      db
        .prepare(
          "SELECT retention_id_prefix,retention_max_age_ms,retention_max_entries FROM delivery_queue_entries",
        )
        .get(),
    ).toEqual({
      retention_id_prefix: "keep:",
      retention_max_age_ms: 86400000,
      retention_max_entries: 2,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db.exec(
        "UPDATE worker_session_placements SET state='active',recovery_error=NULL WHERE session_id='placement-pending'",
      ),
    ).toThrow(/CHECK/u);
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    expect(snapshot(db)).toEqual(after);
    db.exec(
      "UPDATE worker_session_placements SET recovery_error=recovery_error WHERE session_id='placement-pending'",
    );
    expect(
      db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key='fixture.observed'")
        .get(),
    ).toEqual({ value_json: "true" });
  });
});

it.each(["claim", "schema", "publication"] as const)(
  "refuses %s without advancing markers or discarding custody",
  async (refusal) => {
    const options = fixture(refusal);
    await withStateMigrationBackupForTest(options, () => {
      using db = new DatabaseSync(options.path);
      const before = snapshot(db);
      const shape = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'")
        .get();
      const warnings = repairOpenClawStateDatabaseSchema(options).warnings.join("\n");
      expect(warnings).toContain(
        refusal === "claim"
          ? "retains a worker turn claim"
          : refusal === "schema"
            ? "Unrecognized historical worker placement schema"
            : "fixture publication refusal",
      );
      expect(snapshot(db)).toEqual(before);
      expect(
        db.prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'").get(),
      ).toEqual(shape);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(21);
      if (refusal === "publication") {
        db.exec("DROP TRIGGER refuse_publication");
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
      }
    });
  },
);
