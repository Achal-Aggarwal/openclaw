import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { removePathWithinRoot } from "./fs-safe-remove.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { withExistingSqliteRollbackDatabase } from "./sqlite-existing-database.js";
import { createPrivateSqliteTempDirectorySync } from "./sqlite-private-directory.js";
import { hashPublishedFileSync } from "./sqlite-snapshot-file.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

/** Keep recovery scratch attached to its original journal/control authority.
 * The callback must recheck the supplied guard after awaited transport, before
 * opening the result. Cleanup never adopts a successor directory or parent. */
async function withSqliteRecoverySnapshot<T>(
  control: string,
  assertCurrent: () => void,
  read: (targetPath: string, assertSnapshot: () => void) => Promise<T>,
): Promise<T> {
  const assertOwner = retainMutationAuthority(assertCurrent);
  assertOwner();
  const directory = createPrivateSqliteTempDirectorySync(control, ".recovery-snapshot-");
  const original = fs.lstatSync(directory, { bigint: true });
  const assertSnapshot = (allowMissing = false) => {
    assertOwner();
    const current = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (
      (!current && !allowMissing) ||
      (current &&
        (!current.isDirectory() ||
          current.isSymbolicLink() ||
          (process.platform !== "win32" && (current.mode & 0o077n) !== 0n) ||
          current.dev !== original.dev ||
          current.ino !== original.ino))
    ) {
      throw new Error("SQLite recovery snapshot directory changed.");
    }
  };
  let outcome: { value: T } | { error: unknown };
  try {
    assertSnapshot();
    const value = await read(path.join(directory, "operation.sqlite"), assertSnapshot);
    assertSnapshot();
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await removePathWithinRoot({
      rootDir: control,
      relativePath: path.basename(directory),
      recursive: true,
      force: true,
      assertBeforeMutation: () => assertSnapshot(true),
    });
  } catch (error) {
    cleanupFailure = { error };
  }
  if (cleanupFailure) {
    if ("error" in outcome) {
      throw new AggregateError(
        [outcome.error, cleanupFailure.error],
        "Recovery snapshot and owned cleanup failed.",
        { cause: outcome.error },
      );
    }
    throw cleanupFailure.error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Prepare evidence without replaying the source journal; only its live owner may admit rollback. */
export async function prepareSqliteRollbackRecovery<T>(params: {
  path: string;
  scratchRoot: string;
  assertIdentity: () => void;
  assertFileSafe: (file: string, stat: fs.BigIntStats) => void;
  /** The storage owner bounds and decodes its exact committed record or row set. */
  read: (database: DatabaseSync) => T;
}): Promise<{
  record: T;
  assertUnchanged: () => void;
  admit: (assertCurrent: () => void) => void;
}> {
  const fingerprint = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      return null;
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error("SQLite recovery requires regular unshared database and sidecar files.");
    }
    params.assertFileSafe(file, stat);
    // Recovery is cold: no pager lock is held while these raw descriptors close.
    const content = hashPublishedFileSync(file, stat);
    return `${stat.dev}:${stat.ino}:${readDatabaseIdentityBirthtime(stat)}:${stat.size}:${content.sha256}`;
  };
  params.assertIdentity();
  const files = [params.path, `${params.path}-journal`, `${params.path}-wal`, `${params.path}-shm`];
  const identities = files.map(fingerprint);
  const assertUnchanged = () => {
    params.assertIdentity();
    if (files.some((file, index) => fingerprint(file) !== identities[index])) {
      throw new Error("SQLite recovery database or journal changed.");
    }
  };
  const read = () =>
    withExistingSqliteRollbackDatabase(
      params.path,
      {
        write: false,
        busyTimeoutMs: 0,
        assertIdentity: params.assertIdentity,
        // The bounded owner reader validates its schema and decoded records together.
        validate: () => undefined,
      },
      params.read,
    );
  let record: T;
  let hot = false;
  try {
    record = read();
  } catch (error) {
    if (!(error instanceof Error && "errcode" in error && error.errcode === 776)) {
      throw error;
    }
    hot = true;
    assertUnchanged();
    if (identities[2] !== null || identities[3] !== null) {
      throw new Error("SQLite rollback recovery refuses retained WAL or shared-memory artifacts.", {
        cause: error,
      });
    }
    record = await withSqliteRecoverySnapshot(
      params.scratchRoot,
      params.assertIdentity,
      async (targetPath, assertSnapshot) => {
        await createVerifiedSqliteSnapshot({
          sourcePath: params.path,
          targetPath,
          preserveRowIds: true,
          validate: (database) => {
            params.read(database);
          },
        });
        assertSnapshot();
        const snapshot = openNodeSqliteDatabase(targetPath, { readOnly: true });
        try {
          return params.read(snapshot);
        } finally {
          snapshot.close();
        }
      },
    );
  }
  assertUnchanged();
  const assertRecord = (actual: T) => {
    if (!isDeepStrictEqual(record, actual)) {
      throw new Error("SQLite recovery record changed after preparation.");
    }
  };
  return {
    record,
    assertUnchanged,
    admit(assertCurrent) {
      assertUnchanged();
      assertCurrent();
      if (!hot) {
        assertRecord(read());
        return;
      }
      const database = openNodeSqliteDatabase(resolveExistingSqliteFileUri(params.path));
      try {
        params.assertIdentity();
        assertCurrent();
        const mode = database // sqlite-allow-raw -- Explicit owner admission lets SQLite replay its native hot rollback journal.
          .prepare("PRAGMA journal_mode")
          .get()?.journal_mode;
        if (!["delete", "truncate", "persist"].includes(String(mode))) {
          throw new Error("SQLite recovery requires rollback journal mode.");
        }
        assertRecord(params.read(database));
      } finally {
        database.close();
      }
    },
  };
}
