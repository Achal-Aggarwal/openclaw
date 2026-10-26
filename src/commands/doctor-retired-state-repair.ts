// Temporary #174343 upgrade dead-end repair; remove after 2026-11-29 with
// Doctor compat record doctor-pre-july-retired-state.
import os from "node:os";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { updateCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { normalizeConversationRef } from "../infra/outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding.types.js";
import { withLegacyMigrationStateLock } from "../infra/state-migrations.lock.js";
import { listRetiredRestartSentinelFiles } from "../infra/state-migrations.restart-sentinel.js";
import {
  archiveRetiredStateFiles,
  importRetiredStateSource,
} from "../infra/state-migrations.retired-archive.js";
import { listRetiredDeliveryQueueFiles } from "../infra/state-migrations.retired-delivery-files.js";
import { listExistingRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import { listRetiredRuntimeStateFiles } from "../infra/state-migrations.retired-runtime-files.js";
import { backupLegacyStateSource } from "../infra/state-migrations.source-backup.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "../plugins/conversation-binding-state.kernel.js";
import { resolveLegacyInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

type RetiredRuntimeMigrationParams = {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};

function normalizeLegacyBinding(input: unknown): SessionBindingRecord {
  const value = asRecord(input);
  const ref = asRecord(value.conversation);
  const channel = normalizeOptionalString(ref.channel);
  const conversationId = normalizeOptionalString(ref.conversationId);
  const targetSessionKey = normalizeOptionalString(value.targetSessionKey);
  if (!channel || !conversationId || !targetSessionKey) {
    throw new Error("Invalid legacy conversation binding");
  }
  const conversation = normalizeConversationRef({
    channel,
    accountId: normalizeOptionalString(ref.accountId) ?? "default",
    conversationId,
    ...(typeof ref.parentConversationId === "string"
      ? { parentConversationId: ref.parentConversationId }
      : {}),
  });
  const key = [
    conversation.channel,
    conversation.accountId,
    conversation.parentConversationId ?? "",
    conversation.conversationId,
  ].join("\u241f");
  return {
    bindingId: `generic:${key}`,
    targetSessionKey,
    targetKind: value.targetKind === "subagent" ? "subagent" : "session",
    conversation,
    status: value.status === "ending" || value.status === "ended" ? value.status : "active",
    boundAt:
      typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
        ? Math.floor(value.boundAt)
        : Date.now(),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? { expiresAt: Math.floor(value.expiresAt) }
      : {}),
    ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? { metadata: asRecord(value.metadata) }
      : {}),
  };
}

/** Doctor-only import; ordinary runtime readers never open these retired sources. */
async function migrateRetiredRuntimeState(
  params: RetiredRuntimeMigrationParams,
): Promise<MigrationMessages> {
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  const result: MigrationMessages = { changes: [], warnings: [] };
  async function migrate<T>(
    relative: string,
    parse: (value: unknown) => T,
    commit: (value: T) => void,
    recoveryInstructions: string,
  ) {
    const filePath = path.join(params.stateDir, relative);
    if (listExistingRetiredStateFiles([filePath]).length === 0) {
      return;
    }
    await importRetiredStateSource({
      source: await backupLegacyStateSource({ filePath, assertCurrent: params.assertCurrent }),
      label: relative,
      parse: (bytes) => parse(JSON.parse(decodeUtf8Input(bytes, `Legacy ${relative}`))),
      commit,
      recoveryInstructions,
      result,
    });
  }
  await migrate(
    "settings/voicewake.json",
    (value) => {
      const triggers = normalizeTrimmedStringList(asRecord(value).triggers);
      if (triggers.length === 0) {
        throw new Error("No valid voice wake triggers");
      }
      return triggers;
    },
    (triggers) => {
      updateConfigMachineState(
        "voicewake.triggers",
        (current) => (current === undefined ? triggers : current),
        { env },
      );
    },
    "Restore the listed trigger phrases through Voice Wake settings.",
  );
  await migrate(
    "settings/voicewake-routing.json",
    (value) => {
      const routing = asRecord(value);
      if (!Array.isArray(routing.routes)) {
        throw new Error("Invalid voice wake routing rules");
      }
      return routing;
    },
    // The canonical Voice Wake reader owns route normalization, including legacy defaults.
    (routing) => {
      updateConfigMachineState(
        "voicewake.routing",
        (current) => (current === undefined ? routing : current),
        { env },
      );
    },
    "Restore the archived defaultTarget and routes through Voice Wake routing settings.",
  );
  await migrate(
    "bindings/current-conversations.json",
    (value) => {
      const file = asRecord(value);
      if (file.version !== 1 || !Array.isArray(file.bindings)) {
        throw new Error("Expected version 1 conversation bindings");
      }
      return file.bindings.map(normalizeLegacyBinding);
    },
    (records) => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          params.assertCurrent();
          for (const record of records) {
            // An expired canonical binding still supersedes this older source.
            const existing = executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<
                Pick<OpenClawStateKyselyDatabase, "current_conversation_bindings">
              >(db)
                .selectFrom("current_conversation_bindings")
                .select("binding_key")
                .where("binding_key", "=", record.bindingId.slice("generic:".length)),
            );
            if (!existing) {
              updateCurrentConversationBindingRecordInDatabase(
                db,
                record.conversation,
                () => record,
              );
            }
          }
        },
        { env },
      );
    },
    "Use /focus in each archived conversation to reconnect its target session.",
  );
  // The old approvals writer used the default home even when a profile was selected.
  const defaultStateDir = path.join(resolveRequiredHomeDir(env, os.homedir), ".openclaw");
  if (path.resolve(params.stateDir) === path.resolve(defaultStateDir)) {
    await migrate(
      "plugin-binding-approvals.json",
      (value) => {
        const file = asRecord(value);
        if (file.version !== 1 || !Array.isArray(file.approvals)) {
          throw new Error("Expected version 1 plugin binding approvals");
        }
        return file.approvals.map((input: unknown) => {
          const entry = asRecord(input);
          const pluginRoot = normalizeOptionalString(entry.pluginRoot);
          const pluginId = normalizeOptionalString(entry.pluginId);
          const channel = normalizeOptionalString(entry.channel)?.toLowerCase();
          if (!pluginRoot || !pluginId || !channel) {
            throw new Error("Invalid plugin binding approval");
          }
          return {
            pluginRoot,
            pluginId,
            channel,
            accountId: normalizeOptionalString(entry.accountId) ?? "default",
            pluginName: normalizeOptionalString(entry.pluginName),
            approvedAt:
              typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
                ? Math.floor(entry.approvedAt)
                : Date.now(),
          };
        });
      },
      (approvals) => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            params.assertCurrent();
            const existing = readPluginBindingApprovalsInDatabase(db);
            for (const approval of approvals) {
              if (
                !existing.some(
                  (entry) =>
                    entry.pluginRoot === approval.pluginRoot &&
                    entry.channel === approval.channel &&
                    entry.accountId === approval.accountId,
                )
              ) {
                upsertPluginBindingApprovalInDatabase(db, approval);
              }
            }
          },
          { env },
        );
      },
      "Review and approve the plugin again when binding its channel conversation.",
    );
  }
  const archived = await archiveRetiredStateFiles({
    label: "runtime replay and notification state",
    paths: [
      ...["acp/event-ledger.json", "acp/event-ledger.json.doctor-import", "update-check.json"].map(
        (file) => path.join(params.stateDir, file),
      ),
      ...listRetiredRestartSentinelFiles(params.stateDir),
    ],
    assertCurrent: params.assertCurrent,
    recoveryInstructions:
      "Replay history and restart notifications are no longer active. Consult this archive to recover old event or notification details; new sessions and update checks rebuild runtime state.",
  });
  result.changes.push(...archived.changes);
  result.warnings.push(...archived.warnings);
  return result;
}

/** Run before plugin discovery and config recovery can hide the original locators. */
export async function repairRetiredDoctorState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MigrationMessages> {
  const stateDir = resolveStateDir(env);
  const queueFiles = listRetiredDeliveryQueueFiles(stateDir);
  const indexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  if (
    listExistingRetiredStateFiles([
      ...listRetiredRuntimeStateFiles(stateDir, env),
      ...queueFiles,
      indexPath,
    ]).length === 0
  ) {
    return { changes: [], warnings: [] };
  }
  return withLegacyMigrationStateLock({
    stateDir,
    env,
    label: "retired state",
    releaseLabel: "Retired state",
    run: async (stateEnv) => {
      const maintenance = getOpenClawDatabaseMaintenanceScope();
      if (!maintenance) {
        throw new Error("Retired state repair requires exclusive maintenance ownership");
      }
      const assertCurrent = maintenance.assertOwnerCurrent;
      const result = await migrateRetiredRuntimeState({ stateDir, env: stateEnv, assertCurrent });
      for (const archive of [
        {
          label: "delivery queue",
          paths: queueFiles,
          recoveryInstructions:
            "Legacy deliveries are not replayed automatically because they may already have been sent. Inspect the archived payload and explicitly resend any still-needed message through its channel; do not restore it to the queue.",
        },
        {
          label: "plugin install index",
          paths: [indexPath],
          recoveryInstructions:
            "Doctor rebuilds the plugin inventory from configured installs. If a plugin is missing, inspect this archive for its package spec and run openclaw plugins install <package-spec>.",
        },
      ]) {
        const archived = await archiveRetiredStateFiles({ ...archive, assertCurrent });
        result.changes.push(...archived.changes);
        result.warnings.push(...archived.warnings);
      }
      return { ...result, warningDisposition: "recoverable" };
    },
  });
}
