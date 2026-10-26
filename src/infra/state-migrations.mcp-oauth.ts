// Doctor-only import for retired per-server MCP OAuth JSON stores.
import fs from "node:fs";
import path from "node:path";
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/core";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { mcpOAuthStoreKeyFromLegacyFileName } from "../agents/mcp-oauth-identity.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { pathMayExistSync } from "./path-existence.js";
import type { SqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { assertAllowedJsonFields } from "./state-migrations.json-fields.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { withRootBoundedLegacyFileLock } from "./state-migrations.mcp-oauth-lock.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import type {
  LegacyMcpOAuthImportResult,
  PreparedLegacyMcpOAuthImport,
} from "./state-migrations.mcp-oauth.worker-contract.js";
import { resolveLegacyMigrationSourceKey } from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const STORE_KEYS = new Set([
  "clientInformation",
  "tokens",
  "tokenExpiresAt",
  "codeVerifier",
  "discoveryState",
  "lastAuthorizationUrl",
  "redirectUrl",
  "state",
]);
const DISCOVERY_KEYS = new Set([
  "authorizationServerUrl",
  "authorizationServerMetadata",
  "resourceMetadata",
  "resourceMetadataUrl",
]);

function parseSafeUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  const parsed = URL.parse(value);
  if (!parsed) {
    throw new Error(`${label} is not a valid URL`);
  }
  if (["javascript:", "data:", "vbscript:"].includes(parsed.protocol)) {
    throw new Error(`${label} uses an unsafe URL scheme`);
  }
  return value;
}

function parseDiscoveryState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("legacy MCP OAuth discovery state is not an object");
  }
  assertAllowedJsonFields(value, DISCOVERY_KEYS, "legacy MCP OAuth discovery state", {
    reportField: false,
  });
  const result: Record<string, unknown> = {
    authorizationServerUrl: parseSafeUrl(
      value.authorizationServerUrl,
      "legacy MCP OAuth authorization server URL",
    ),
  };
  if (value.authorizationServerMetadata !== undefined) {
    const oauth = OAuthMetadataSchema.safeParse(value.authorizationServerMetadata);
    const oidc = oauth.success
      ? null
      : OpenIdProviderDiscoveryMetadataSchema.safeParse(value.authorizationServerMetadata);
    if (!oauth.success && !oidc?.success) {
      throw new Error("legacy MCP OAuth authorization server metadata is invalid");
    }
    result.authorizationServerMetadata = value.authorizationServerMetadata;
  }
  if (value.resourceMetadata !== undefined) {
    const parsed = OAuthProtectedResourceMetadataSchema.safeParse(value.resourceMetadata);
    if (!parsed.success) {
      throw new Error("legacy MCP OAuth resource metadata is invalid");
    }
    result.resourceMetadata = value.resourceMetadata;
  }
  if (value.resourceMetadataUrl !== undefined) {
    result.resourceMetadataUrl = parseSafeUrl(
      value.resourceMetadataUrl,
      "legacy MCP OAuth resource metadata URL",
    );
  }
  return result;
}

function parseLegacyMcpOAuthStore(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("legacy MCP OAuth store is not an object");
  }
  assertAllowedJsonFields(value, STORE_KEYS, "legacy MCP OAuth store", { reportField: false });
  const result: Record<string, unknown> = {};
  for (const [key, schema, message] of [
    ["clientInformation", OAuthClientInformationSchema, "client information is invalid"],
    ["tokens", OAuthTokensSchema, "tokens are invalid"],
  ] as const) {
    if (value[key] !== undefined) {
      if (!schema.safeParse(value[key]).success) {
        throw new Error(`legacy MCP OAuth ${message}`);
      }
      result[key] = value[key];
    }
  }
  if (value.tokenExpiresAt !== undefined) {
    if (
      typeof value.tokenExpiresAt !== "number" ||
      !Number.isFinite(value.tokenExpiresAt) ||
      value.tokenExpiresAt < 0 ||
      value.tokenExpiresAt > MAX_TIMESTAMP_MS
    ) {
      throw new Error("legacy MCP OAuth token expiry is invalid");
    }
    if (result.tokens !== undefined) {
      result.tokenExpiresAt = value.tokenExpiresAt;
    }
  }
  if (value.codeVerifier !== undefined) {
    if (typeof value.codeVerifier !== "string" || value.codeVerifier.length === 0) {
      throw new Error("legacy MCP OAuth code verifier is invalid");
    }
    result.codeVerifier = value.codeVerifier;
  }
  if (value.discoveryState !== undefined) {
    result.discoveryState = parseDiscoveryState(value.discoveryState);
  }
  for (const [key, label] of [
    ["lastAuthorizationUrl", "authorization URL"],
    ["redirectUrl", "redirect URL"],
  ] as const) {
    if (value[key] !== undefined) {
      result[key] = parseSafeUrl(value[key], `legacy MCP OAuth ${label}`);
    }
  }
  // `state` was persisted but never read. Doctor deliberately leaves it retired.
  return result;
}

type ImportOutcome =
  | { ok: true; value: LegacyMcpOAuthImportResult; deliveryFailure?: { error: unknown } }
  | { ok: false; error: unknown; restoreSource: boolean };

/** Keep the filesystem claim until the original native writer's outcome is known. */
async function importLegacyMcpOAuthStore(
  context: OpenClawStateWorkerContext,
  input: PreparedLegacyMcpOAuthImport,
): Promise<ImportOutcome> {
  let retained:
    | { operation: RetainedWorkerTransactionAdmission; admission: SqliteWorkerOperationAdmission }
    | undefined;
  let commitRequested = false;
  const createAdmission = createSqliteWorkerWriteAdmission(
    (request) => {
      context.admission.assertCurrent();
      if (request.stage === "commit") {
        // A failed grant may be definite, but it never justifies restoring an uncertain claim.
        commitRequested = true;
      }
    },
    [context.admission.databasePath],
  );
  try {
    const value = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "legacyMcpOAuth.import", input }),
      {
        createAdmission(operation) {
          const created = createAdmission(operation);
          retained = { operation, admission: created.admission };
          return created;
        },
      },
    );
    return { ok: true, value };
  } catch (error) {
    if (!retained) {
      return { ok: false, error, restoreSource: true };
    }
    const settlement = await retained.operation.settled;
    const facts = retained.admission.committed?.facts;
    if (
      settlement.kind === "completed" &&
      isRecord(facts) &&
      facts.sourceKey === input.sourceKey &&
      typeof facts.imported === "boolean"
    ) {
      return {
        ok: true,
        value: { sourceKey: input.sourceKey, imported: facts.imported },
        deliveryFailure: { error },
      };
    }
    return {
      ok: false,
      error,
      restoreSource:
        settlement.kind === "not-entered" || (settlement.kind === "completed" && !commitRequested),
    };
  }
}

const LEGACY_MCP_OAUTH_DIR = "mcp-oauth";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MAX_LEGACY_STORE_BYTES = 4 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type LegacySourceSnapshot = LegacyMigrationSourceSnapshot & { store: Record<string, unknown> };

function parseLegacyMcpOAuthJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(buffer));
  } catch {
    throw new Error("legacy MCP OAuth store contains invalid JSON");
  }
}

function exactLegacyBaseName(name: string): string | null {
  const baseName = name.endsWith(DOCTOR_CLAIM_SUFFIX)
    ? name.slice(0, -DOCTOR_CLAIM_SUFFIX.length)
    : name;
  return mcpOAuthStoreKeyFromLegacyFileName(baseName) ? baseName : null;
}

function exactLegacyBaseNames(entries: Iterable<{ name: string }>): string[] {
  const baseNames = new Set<string>();
  for (const entry of entries) {
    const baseName = exactLegacyBaseName(entry.name);
    if (baseName) {
      baseNames.add(baseName);
    }
  }
  return Array.from(baseNames).toSorted();
}

async function listLegacySourcePathsFromRoot(params: {
  stateRoot: Root;
  stateDir: string;
}): Promise<string[]> {
  // Validate the legacy directory through the pinned root before creating any
  // retired-runtime lock sidecars. A symlinked directory must never escape stateDir.
  const entries = await params.stateRoot.list(LEGACY_MCP_OAUTH_DIR, {
    withFileTypes: true,
  });
  return exactLegacyBaseNames(entries).map((baseName) =>
    path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR, baseName),
  );
}

/** Detect exact retired MCP OAuth filenames only for an explicit Doctor flow. */
export function detectLegacyMcpOAuthStores(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyMcpOAuthDetection {
  const sourceDir = path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR);
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourceDir, sourcePaths: [], hasLegacy: false };
  }
  try {
    const sourcePaths = exactLegacyBaseNames(
      fs.readdirSync(sourceDir, { withFileTypes: true }),
    ).map((baseName) => path.join(sourceDir, baseName));
    return { sourceDir, sourcePaths, hasLegacy: sourcePaths.length > 0 };
  } catch {
    return { sourceDir, sourcePaths: [], hasLegacy: pathMayExistSync(sourceDir) };
  }
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  options: { parseStore?: boolean } = {},
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_STORE_BYTES,
    label: "MCP OAuth",
  });
  const parsed =
    options.parseStore === false
      ? {}
      : parseLegacyMcpOAuthStore(parseLegacyMcpOAuthJson(snapshot.buffer));
  return { ...snapshot, store: parsed };
}

function storeKeyForSource(sourcePath: string): string {
  const storeKey = mcpOAuthStoreKeyFromLegacyFileName(path.basename(sourcePath));
  if (!storeKey) {
    throw new Error("legacy MCP OAuth filename is invalid");
  }
  return storeKey;
}

async function markLegacySourceRemoved(context: OpenClawStateWorkerContext, sourceKey: string) {
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "legacyMcpOAuth.markRemoved", input: { sourceKey } }),
    {
      createAdmission: createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

async function migrateOneStore(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  context: OpenClawStateWorkerContext;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath: params.sourcePath,
    label: "MCP OAuth",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  await source.recoverLinkedMove();
  const sourceKey = resolveLegacyMigrationSourceKey("mcp-oauth-json", params.sourcePath);
  const receipt = await executeOpenClawStateWorker(params.context, {
    type: "legacyMcpOAuth.readReceipt",
    input: { sourceKey },
  });
  if (receipt) {
    try {
      const removed = await source.removeRetiredSources({
        readSnapshot: (candidate) =>
          readLegacySourceSnapshot(params.stateRoot, params.stateDir, candidate, {
            parseStore: false,
          }),
        removeSource: params.removeSource,
      });
      if (!receipt.removedSource || removed > 0) {
        await markLegacySourceRemoved(params.context, receipt.sourceKey);
      }
      if (removed > 0) {
        changes.push("Discarded recreated retired MCP OAuth JSON without importing it.");
      }
    } catch (error) {
      warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    }
    return { changes, warnings };
  }

  const hasSource = await source.exists();
  const hasClaim = await source.exists(true);
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: [
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: source and interrupted claim both exist.`,
      ],
    };
  }
  const activePath = hasSource ? params.sourcePath : hasClaim ? source.claimPath : null;
  if (!activePath) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, activePath);
  } catch (error) {
    warnings.push(
      `Failed reading legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  let result: LegacyMcpOAuthImportResult;
  let restoreSource = true;
  try {
    if (activePath === params.sourcePath) {
      snapshot = await source.claim({
        snapshot,
        mismatchMessage: "legacy MCP OAuth source changed before Doctor could claim it",
        beforeClaim: () => params.beforeClaim?.(params.sourcePath),
      });
    }
    // Only the worker's definite pre-commit outcome can release this claim back to legacy code.
    restoreSource = false;
    const outcome = await importLegacyMcpOAuthStore(params.context, {
      sourceKey,
      sourcePath: params.sourcePath,
      storeKey: storeKeyForSource(params.sourcePath),
      sourceSha256: snapshot.sha256,
      sourceSizeBytes: snapshot.size,
      store: snapshot.store,
      now: Date.now(),
    });
    if (!outcome.ok) {
      restoreSource = outcome.restoreSource;
      throw outcome.error;
    }
    result = outcome.value;
    if (outcome.deliveryFailure) {
      warnings.push(
        `MCP OAuth import committed, but result delivery failed: ${String(outcome.deliveryFailure.error)}`,
      );
    }
  } catch (error) {
    const restoreError = restoreSource ? await source.restore() : undefined;
    warnings.push(
      `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}${restoreSource ? "" : "; SQLite import outcome is unresolved; retained Doctor claim for receipt verification on the next run."}`,
    );
    return { changes, warnings };
  }

  try {
    if (await source.exists()) {
      throw new Error("legacy MCP OAuth source reappeared during import");
    }
    await source.verify(snapshot, "legacy MCP OAuth claim changed after SQLite import", true);
    await source.remove({
      removeSource: params.removeSource,
      claimRemainingMessage: "legacy MCP OAuth Doctor claim remains after cleanup",
      skipSourceCheck: true,
    });
    await markLegacySourceRemoved(params.context, result.sourceKey);
  } catch (error) {
    warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    result.imported
      ? `Migrated MCP OAuth store ${path.basename(params.sourcePath)} to SQLite.`
      : `Preserved canonical SQLite MCP OAuth store for ${path.basename(params.sourcePath)}.`,
  );
  notices.push("Removed retired MCP OAuth JSON after verified SQLite import.");
  return { changes, warnings, notices };
}

/** Import retired MCP OAuth stores while excluding old Gateways that can recreate them. */
export async function migrateLegacyMcpOAuthStores(params: {
  detected: LegacyMcpOAuthDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeLegacyLock?: (sourcePath: string) => void;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy MCP OAuth stores",
    releaseLabel: "MCP OAuth",
    errorLabel: "Failed reading legacy MCP OAuth state",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_STORE_BYTES,
        symlinks: "reject",
      });
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      let sourcePaths: string[];
      try {
        sourcePaths = await listLegacySourcePathsFromRoot({ stateRoot, stateDir: params.stateDir });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "not-found") {
          return { changes, warnings };
        }
        return {
          changes,
          warnings: [`Failed reading legacy MCP OAuth directory: ${String(error)}`],
        };
      }
      const context = captureOpenClawStateWorkerContext({ env });
      for (const sourcePath of sourcePaths) {
        try {
          // Retired releases serialize complete refresh/login flows on this exact
          // path. Hold their lock while claiming bytes so an old CLI cannot race Doctor.
          params.beforeLegacyLock?.(sourcePath);
          const result = await withRootBoundedLegacyFileLock(
            {
              stateRoot,
              targetRelativePath: resolveLegacyMigrationRelativePath(
                params.stateDir,
                sourcePath,
                "MCP OAuth",
                false,
              ),
            },
            async () => await migrateOneStore({ ...params, stateRoot, sourcePath, context }),
          );
          changes.push(...result.changes);
          warnings.push(...result.warnings);
          notices.push(...(result.notices ?? []));
        } catch (error) {
          const staleGuidance =
            (error as { code?: unknown }).code === "file_lock_stale"
              ? " Verify no older OpenClaw process is running, remove the retired .lock sidecar, and rerun Doctor."
              : "";
          warnings.push(
            `Failed locking legacy MCP OAuth store ${path.basename(sourcePath)}: ${String(error)}.${staleGuidance}`,
          );
        }
      }
      return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
    },
  });
}
