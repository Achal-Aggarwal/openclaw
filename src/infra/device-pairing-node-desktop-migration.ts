// Preserve shipped Gateway opt-outs while moving desktop access to pairing approval.
import { randomUUID } from "node:crypto";
import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  clearNodePairingGenerationState,
  resolveNodePairingGeneration,
} from "./device-pairing-identity.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  withDevicePairingStoreDatabase,
} from "./device-pairing-store.js";
import type { PairedDevice } from "./device-pairing.types.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";

const MIGRATION_ID = "node-desktop-stream-pairing-defaults-v1";

/** Also applies to old file-backed surfaces imported after the SQLite migration completed. */
export function preserveLegacyDesktopStreamOptOut(
  device: PairedDevice,
  cfg: OpenClawConfig,
  now: number,
): boolean {
  const commands = cfg.gateway?.nodes?.commands;
  if (
    [commands?.allow, commands?.deny].some((entries) =>
      entries?.some((command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND),
    )
  ) {
    return false;
  }
  const surface = device.nodeSurface;
  if (
    !Array.isArray(surface?.commands) ||
    !surface.commands.some(
      (command) => typeof command === "string" && command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    )
  ) {
    return false;
  }
  if (
    !isStringArray(surface.commands) ||
    !Number.isSafeInteger(surface.createdAtMs) ||
    !Number.isSafeInteger(surface.approvedAtMs) ||
    !Number.isSafeInteger(surface.approvedAtMs + 1)
  ) {
    throw new Error(`Cannot migrate malformed desktop approval for node ${device.deviceId}`);
  }
  const previousGeneration = resolveNodePairingGeneration(device);
  surface.commands = surface.commands.filter(
    (command) => command.trim() !== NODE_DESKTOP_STREAM_COMMAND,
  );
  surface.approvedAtMs = Math.max(now, surface.approvedAtMs + 1);
  clearNodePairingGenerationState(device, previousGeneration);
  if (
    device.pendingNodeSurface?.commands?.some(
      (command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    )
  ) {
    device.pendingNodeSurface.silent = false;
    device.pendingNodeSurface.revision = randomUUID();
  }
  return true;
}

/** Commit narrowed approvals and the once-per-database receipt together before node admission. */
export function migrateLegacyDesktopStreamOptOuts(
  cfg: OpenClawConfig,
  database: OpenClawStateDatabase,
): number {
  return withDevicePairingStoreDatabase(database, () => {
    if (isArtifactPreservingStateRead("agent", database.path)) {
      throw new Error(
        "Programming error: shared-state write during artifact-preserving inspection.",
      );
    }
    const receipt = executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "migration_runs">>(database.db)
        .selectFrom("migration_runs")
        .select("status")
        .where("id", "=", MIGRATION_ID),
    );
    if (receipt?.status === "completed") {
      return 0;
    }
    if (receipt) {
      throw new Error(
        "Desktop approval migration receipt is incomplete; existing approvals remain unchanged.",
      );
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const now = Date.now();
        const state = readDevicePairingStoreStateFromDatabase(db);
        let retired = 0;
        for (const device of Object.values(state.pairedByDeviceId)) {
          if (preserveLegacyDesktopStreamOptOut(device, cfg, now)) {
            retired += 1;
          }
        }
        if (retired > 0) {
          persistDevicePairingStoreState(state, undefined, "paired");
        }
        recordLegacyMigrationRun(db, {
          runId: MIGRATION_ID,
          startedAt: now,
          finishedAt: now,
          status: "completed",
          reportJson: JSON.stringify({ retiredDesktopApprovals: retired }),
        });
        return retired;
      },
      { database },
      { operationLabel: "preserve legacy desktop stream opt-outs" },
    );
  });
}
