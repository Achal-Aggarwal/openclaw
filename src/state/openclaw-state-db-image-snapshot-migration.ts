import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readWorkerPreparation } from "../gateway/worker-environments/preparation-identity.schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export function hasHistoricalImageReserveSnapshots(db: DatabaseSync): boolean {
  return (
    tableExists(db, "worker_environments") &&
    Boolean(
      db
        .prepare(`SELECT 1
    FROM worker_environments WHERE json_valid(profile_snapshot_json)
      AND json_extract(profile_snapshot_json, '$.project.kind') = 'image' LIMIT 1`)
        .get(),
    )
  );
}

/** Doctor owns this data cutover even when an earlier import already published schema 22. */
export function migrateHistoricalImageReserveSnapshots(db: DatabaseSync): string[] {
  if (!tableExists(db, "worker_environments")) {
    return [];
  }
  const rows = db
    .prepare(`SELECT environment_id, profile_snapshot_json FROM worker_environments
    WHERE json_valid(profile_snapshot_json)
      AND json_extract(profile_snapshot_json, '$.project.kind') = 'image'`)
    .all();
  const update = db.prepare(
    "UPDATE worker_environments SET profile_snapshot_json = ? WHERE environment_id = ?",
  );
  for (const row of rows) {
    if (typeof row.profile_snapshot_json !== "string" || typeof row.environment_id !== "string") {
      throw new Error("Historical image reserve row is invalid");
    }
    const profile: unknown = JSON.parse(row.profile_snapshot_json);
    const project = isRecord(profile) ? profile.project : undefined;
    if (
      !isRecord(profile) ||
      !isRecord(project) ||
      project.kind !== "image" ||
      typeof project.key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(project.key) ||
      !isRecord(project.preparation) ||
      profile.runtimePreparation !== undefined ||
      profile.historicalProfileSnapshotJson !== undefined
    ) {
      throw new Error("Historical image reserve snapshot has conflicting or invalid preparation");
    }
    // Main models non-repository preparation as empty; the image identity remains archived.
    profile.runtimePreparation = { ...project.preparation, source: "empty" };
    delete profile.project;
    readWorkerPreparation(profile);
    // Retain original serialized evidence, including the retired image-project key.
    // The current profile owners never consume this archive as preparation authority.
    profile.historicalProfileSnapshotJson = row.profile_snapshot_json;
    // sqlite-allow-raw -- Offline structural migration; all custody/deadline columns stay untouched.
    update.run(JSON.stringify(profile), row.environment_id);
  }
  return rows.length > 0
    ? ["Migrated historical image reserves with original snapshot evidence retained"]
    : [];
}
