import type { DatabaseSync } from "node:sqlite";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { readSqliteTableColumns } from "./openclaw-agent-db-session-migrations.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export function migrateOpenClawAgentSchema(db: DatabaseSync): void {
  if (readSqliteUserVersion(db) >= OPENCLAW_AGENT_SCHEMA_VERSION) {
    return;
  }
  const columns = readSqliteTableColumns(db, "sessions");
  if (!columns) {
    return;
  }
  for (const [name, definition] of Object.entries({
    transcript_updated_at: "INTEGER DEFAULT NULL",
    transcript_observed_at: "INTEGER DEFAULT NULL",
    session_entry_provenance:
      "INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1))",
    acp_owned: "INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1))",
    plugin_owner_id: "TEXT",
    hook_external_content_source:
      "TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook'))",
  })) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition};`);
    }
  }
  if (!tableExists(db, "transcript_events")) {
    return;
  }
  db.exec(`
    UPDATE sessions
    SET
      transcript_updated_at = COALESCE(
        transcript_updated_at,
        (SELECT MAX(transcript_events.created_at)
         FROM transcript_events
         WHERE transcript_events.session_id = sessions.session_id)
      ),
      transcript_observed_at = COALESCE(transcript_observed_at, updated_at)
    WHERE EXISTS (
      SELECT 1 FROM transcript_events
      WHERE transcript_events.session_id = sessions.session_id
    );
  `);
}
