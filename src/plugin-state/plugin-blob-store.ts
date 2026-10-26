import { serialize } from "node:v8";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  reserveSqliteWorkerInputPreparation,
  type SqliteWorkerInputPreparation,
} from "../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  wrapPluginBlobError,
  MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
} from "./plugin-blob-store.sqlite.js";
import type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobRegistrationReceipt,
  PluginBlobOverflowPolicy,
  PluginBlobStoreWithReceipts,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";
import type { PluginBlobWorkerOperations } from "./plugin-blob-store.worker.js";
import {
  pluginBlobWorkerOperations,
  type PluginBlobReadCommand,
} from "./plugin-blob-worker-contract.js";
import {
  createPluginStoreOptionPolicy,
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
  validatePluginStorePositiveInteger,
} from "./plugin-store-validation.js";

export type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobRegistrationReceipt,
  PluginBlobStore,
  PluginBlobStoreWithReceipts,
} from "./plugin-blob-store.types.js";

type Scope = Pick<SqliteWorkerStore<PluginBlobWorkerOperations>, "execute">;
type Input<Key extends keyof PluginBlobWorkerOperations> =
  PluginBlobWorkerOperations[Key]["input"] & { env?: NodeJS.ProcessEnv };

async function execute<Key extends keyof PluginBlobWorkerOperations>(
  env: NodeJS.ProcessEnv | undefined,
  command: { type: Key; input: PluginBlobWorkerOperations[Key]["input"] },
  prepare?: () => SqliteWorkerInputPreparation,
): Promise<PluginBlobWorkerOperations[Key]["output"]> {
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginBlobWorkerOperations[command.type];
  let dispatched = false;
  let preparation: SqliteWorkerInputPreparation | undefined;
  try {
    preparation = prepare?.();
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env });
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope: Scope) => {
        dispatched = true;
        return await (preparation
          ? preparation.handoff(() => scope.execute<Key>(command))
          : scope.execute<Key>(command));
      },
      { assertCurrent: preparation?.assertCurrent },
    );
  } catch (error) {
    throw wrapPluginBlobError(
      error,
      description.operation,
      dispatched ? "PLUGIN_BLOB_WRITE_FAILED" : "PLUGIN_BLOB_OPEN_FAILED",
      dispatched ? description.message : "Failed to open plugin blob store.",
      env,
      databasePath,
    );
  } finally {
    preparation?.release();
  }
}

function captureRegistrationInput(
  type: "pluginBlob.register" | "pluginBlob.registerIfAbsent",
  input: PluginBlobWorkerOperations["pluginBlob.register"]["input"],
): SqliteWorkerInputPreparation {
  const metadataBytes = serialize({
    type,
    input: { ...input, bytes: new Uint8Array() },
  }).byteLength;
  const preparation = reserveSqliteWorkerInputPreparation(input.bytes.byteLength + metadataBytes);
  try {
    input.bytes = Uint8Array.from(input.bytes);
    return preparation;
  } catch (error) {
    preparation.release();
    throw error;
  }
}

function registerPluginBlobInWorker(params: Input<"pluginBlob.register">): Promise<void> {
  const { env, ...input } = params;
  return execute(env, { type: "pluginBlob.register", input }, () =>
    captureRegistrationInput("pluginBlob.register", input),
  );
}

function registerPluginBlobIfAbsentInWorker(
  params: Input<"pluginBlob.registerIfAbsent">,
): Promise<PluginBlobRegistrationReceipt | undefined> {
  const { env, ...input } = params;
  return execute(env, { type: "pluginBlob.registerIfAbsent", input }, () =>
    captureRegistrationInput("pluginBlob.registerIfAbsent", input),
  );
}

function deletePluginBlobInWorker(params: Input<"pluginBlob.delete">): Promise<boolean> {
  const { env, ...input } = params;
  return execute(env, { type: "pluginBlob.delete", input });
}

async function deleteExpiredPluginBlobKeyInWorker<TMetadata>(
  params: Input<"pluginBlob.deleteExpiredKey">,
): Promise<PluginBlobEntryInfo<TMetadata> | undefined> {
  const { env, ...input } = params;
  const entry = await execute(env, { type: "pluginBlob.deleteExpiredKey", input });
  // SAFETY: The plugin namespace owns the metadata type; its kernel validates stored JSON.
  return entry as PluginBlobEntryInfo<TMetadata> | undefined;
}

async function deleteExpiredPluginBlobsInWorker<TMetadata>(
  params: Input<"pluginBlob.deleteExpired">,
): Promise<PluginBlobEntryInfo<TMetadata>[]> {
  const { env, ...input } = params;
  const entries = await execute(env, { type: "pluginBlob.deleteExpired", input });
  // SAFETY: The plugin namespace owns the metadata type; its kernel validates stored JSON.
  return entries as PluginBlobEntryInfo<TMetadata>[];
}

function clearPluginBlobsInWorker(params: Input<"pluginBlob.clear">): Promise<void> {
  const { env, ...input } = params;
  return execute(env, { type: "pluginBlob.clear", input });
}

function readPluginBlob(command: PluginBlobReadCommand, env?: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const operation = command.type === "pluginBlob.lookup" ? "lookup" : "entries";
  // This call captures and retains the selected source before any await.
  return executeExistingOpenClawStateRead({ path: databasePath, env }, command, {
    mapError: (error, phase) =>
      wrapPluginBlobError(
        error,
        operation,
        phase === "before-read" ? "PLUGIN_BLOB_OPEN_FAILED" : "PLUGIN_BLOB_READ_FAILED",
        phase === "before-read"
          ? "Failed to open plugin blob store."
          : operation === "lookup"
            ? "Failed to read plugin blob entry."
            : "Failed to list plugin blob entries.",
        env,
        databasePath,
      ),
  });
}

async function lookupPluginBlobInWorker<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginBlobEntry<TMetadata> | undefined> {
  const { env, ...input } = params;
  const reply = await readPluginBlob({ type: "pluginBlob.lookup", input }, env);
  if (reply === undefined) {
    return undefined;
  }
  if (reply.ok && reply.type === "pluginBlob.lookup") {
    // SAFETY: The plugin namespace owns metadata shape; the read kernel validates JSON.
    return reply.value as PluginBlobEntry<TMetadata> | undefined;
  }
  throw new Error("Unexpected plugin blob lookup reply");
}

async function listPluginBlobsInWorker<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginBlobEntryInfo<TMetadata>[]> {
  const { env, ...input } = params;
  const reply = await readPluginBlob({ type: "pluginBlob.entries", input }, env);
  if (reply === undefined) {
    return [];
  }
  if (reply.ok && reply.type === "pluginBlob.entries") {
    // SAFETY: The plugin namespace owns metadata shape; the read kernel validates JSON.
    return reply.value as PluginBlobEntryInfo<TMetadata>[];
  }
  throw new Error("Unexpected plugin blob entries reply");
}

type BlobStoreOptionSignature = Omit<OpenBlobStoreOptions, "namespace" | "overflowPolicy"> & {
  overflowPolicy: PluginBlobOverflowPolicy;
};

function invalidInput(
  message: string,
  operation: PluginBlobStoreOperation = "register",
): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_INVALID_INPUT",
    operation,
  });
}

function limitError(message: string): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
    operation: "register",
  });
}

function validateNamespace(value: string): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin blob",
    invalid: (message) => invalidInput(message, "open"),
  });
}

function validateKey(value: string, operation: PluginBlobStoreOperation): string {
  return validatePluginStoreKey({
    value,
    label: "plugin blob",
    invalid: (message) => invalidInput(message, operation),
  });
}

function validatePositiveLimit(value: number, label: string, maximum: number): number {
  const normalized = validatePluginStorePositiveInteger({
    value,
    label,
    invalid: (message) => invalidInput(message, "open"),
  });
  if (normalized > maximum) {
    throw invalidInput(`${label} must be <= ${maximum}`, "open");
  }
  return normalized;
}

const optionPolicy = createPluginStoreOptionPolicy<BlobStoreOptionSignature>({
  label: "plugin blob",
  invalid: (message) => invalidInput(message, "open"),
});

function validateTtl(
  value: number | undefined,
  operation: PluginBlobStoreOperation,
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin blob ttlMs",
    invalid: (message) => invalidInput(message, operation),
  });
}

function createPluginBlobStoreInternal<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env?: NodeJS.ProcessEnv,
): PluginBlobStoreWithReceipts<TMetadata> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validatePositiveLimit(
    options.maxEntries,
    "plugin blob maxEntries",
    MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
  );
  const maxBytesPerEntry = validatePositiveLimit(
    options.maxBytesPerEntry,
    "plugin blob maxBytesPerEntry",
    MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  );
  const maxBytesPerNamespace = validatePositiveLimit(
    options.maxBytesPerNamespace,
    "plugin blob maxBytesPerNamespace",
    MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  );
  if (maxBytesPerEntry > maxBytesPerNamespace) {
    throw invalidInput("plugin blob maxBytesPerEntry must not exceed maxBytesPerNamespace", "open");
  }
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateTtl(options.defaultTtlMs, "open");
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    maxBytesPerEntry,
    maxBytesPerNamespace,
    overflowPolicy,
    defaultTtlMs,
  });

  const scope = { pluginId, namespace, ...(env ? { env } : {}) };
  const prepareWrite = (
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ) => {
    const normalizedKey = validateKey(key, "register");
    if (!(bytes instanceof Uint8Array)) {
      throw invalidInput("plugin blob bytes must be a Uint8Array");
    }
    if (bytes.byteLength > maxBytesPerEntry) {
      throw limitError(`plugin blob entry exceeds the configured ${maxBytesPerEntry} byte limit`);
    }
    const metadataJson = serializePluginStoreJson({
      value: metadata,
      label: "plugin blob metadata",
      errors: { invalid: invalidInput, limit: limitError },
    });
    const ttlMs = validateTtl(opts?.ttlMs, "register") ?? defaultTtlMs;
    return {
      ...scope,
      key: normalizedKey,
      // Registration reserves broker capacity before copying, still before its first await.
      bytes,
      metadataJson,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      maxEntries,
      maxBytesPerNamespace,
      overflowPolicy,
    };
  };

  return {
    async register(key, bytes, metadata, opts) {
      await registerPluginBlobInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      return (
        (await registerPluginBlobIfAbsentInWorker(prepareWrite(key, bytes, metadata, opts))) !==
        undefined
      );
    },
    async registerIfAbsentWithReceipt(key, bytes, metadata, opts) {
      return registerPluginBlobIfAbsentInWorker(prepareWrite(key, bytes, metadata, opts));
    },
    async lookup(key) {
      return lookupPluginBlobInWorker<TMetadata>({
        ...scope,
        key: validateKey(key, "lookup"),
      });
    },
    async entries() {
      return listPluginBlobsInWorker<TMetadata>(scope);
    },
    async delete(key) {
      return deletePluginBlobInWorker({
        ...scope,
        key: validateKey(key, "delete"),
      });
    },
    async deleteExpiredKey(key) {
      return deleteExpiredPluginBlobKeyInWorker<TMetadata>({
        ...scope,
        key: validateKey(key, "sweep"),
      });
    },
    async deleteExpired() {
      return deleteExpiredPluginBlobsInWorker<TMetadata>(scope);
    },
    async clear() {
      await clearPluginBlobsInWorker(scope);
    },
  };
}

/** Opens an async blob namespace for a non-core plugin id. */
export function createPluginBlobStore<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
): PluginBlobStoreWithReceipts<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options);
}

/** Test-only factory with an isolated state environment. */
export function createPluginBlobStoreForTests<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env: NodeJS.ProcessEnv,
): PluginBlobStoreWithReceipts<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options, env);
}

/** Resets facade signatures and the shared state database handle for tests. */
export function resetPluginBlobStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  optionPolicy.clear();
  if (options.closeDatabase !== false) {
    closeOpenClawStateDatabaseForTest();
  }
}
