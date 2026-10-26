import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION,
  migrateCronDefaultStoreIdentity,
} from "../state/openclaw-state-db-cron-identity-migration.js";
import { createStateConfigMachineTable } from "../state/openclaw-state-db-schema-v12-foldin.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import type { UpdateStateInspectionProgress } from "./update-candidate-state.diagnostics.js";
import type { StateInput } from "./update-candidate-state.shared.js";

export type UpdateCandidateStateSnapshotInput = StateInput & {
  targetStateDir: string;
  candidateRoot: string;
  pluginPlanPath: string;
  databaseInventory: string[];
  /** Original logical selector, captured before the launcher isolates its paths. */
  sourceCronDefaultStoreKey?: string;
  fullIntegrityCheck?: boolean;
  onProgress?: (progress: UpdateStateInspectionProgress) => void;
};

export function projectUpdateCandidateCronSelection(
  db: DatabaseSync,
  sourceCronDefaultStoreKey: string | undefined,
): number {
  const contentVersion = readStateSchemaContentVersion(db);
  // Older drivers omit this fact. Neither the physical source root nor
  // the isolated worker environment can recover their original selector.
  if (
    sourceCronDefaultStoreKey !== undefined &&
    contentVersion < CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION
  ) {
    createStateConfigMachineTable(db);
    migrateCronDefaultStoreIdentity(db, {
      previousVersion: contentVersion,
      legacyDefaultStoreKey: sourceCronDefaultStoreKey,
    });
  }
  return contentVersion;
}
