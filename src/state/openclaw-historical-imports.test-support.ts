import fs from "node:fs";

export const preparation = {
  key: "a".repeat(64),
  cacheKey: "c".repeat(64),
  contractVersion: 1,
  target: { machineClass: "small", platform: "linux" },
  artifacts: {
    nodeBootstrapSha256: "d".repeat(64),
    enabledPluginIds: [],
    workerBundleHash: "e".repeat(64),
    workerArchiveSha256: "f".repeat(64),
    openclawVersion: "synthetic",
    protocolFeatures: [],
  },
};
export const original = JSON.stringify({
  install: "bundle",
  settings: { provider: "synthetic" },
  project: { kind: "image", key: "b".repeat(64), preparation },
});

// Restore the exact v22 DDL from 1f0deff4a1784c8 using the existing frozen v24 fixture.
export function stateV22Schema() {
  return fs
    .readFileSync(
      new URL("../../test/fixtures/sqlite/openclaw-state-schema-v24.sql", import.meta.url),
      "utf8",
    )
    .replace(
      /CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_run[\s\S]*?(?=CREATE TABLE IF NOT EXISTS subagent_runs)/u,
      [
        "CREATE INDEX IF NOT EXISTS idx_task_runs_run_id ON task_runs(run_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_status ON task_runs(runtime, status);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_after ON task_runs(cleanup_after);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_last_event_at ON task_runs(last_event_at);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_owner_key ON task_runs(owner_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_parent_flow_id ON task_runs(parent_flow_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_child_session_key ON task_runs(child_session_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_requester_session_key ON task_runs(requester_session_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_source_ended",
        "  ON task_runs(runtime, source_id, ended_at, created_at, task_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_ended",
        "  ON task_runs(runtime, ended_at, created_at, task_id);",
        "",
        "",
      ].join("\n"),
    )
    .replace("  started_at_ms INTEGER,\n", "")
    .replace(
      /CREATE INDEX IF NOT EXISTS idx_meeting_transcript_sessions_chronology[^;]*;\n\n/u,
      "",
    );
}
