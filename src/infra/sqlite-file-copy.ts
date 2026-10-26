import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { copyRootFileSync, sameFileIdentity } from "@openclaw/fs-safe/advanced";
import type { RootCopyPublicationReceipt } from "@openclaw/fs-safe/root";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { FsSafeError, root } from "./fs-safe.js";

/** Copy a physical SQLite file, not a coherent family. Its caller owns coherence and byte checks. */
export async function copySqliteFile(
  sourcePath: string,
  targetPath: string,
  expectedIdentity: BigIntStats,
  beforeByteCopy?: (sizeBytes: number) => void | Promise<void>,
  onCopy?: (method: "clone" | "copy") => void,
): Promise<RootCopyPublicationReceipt> {
  const sourceRoot = await root(path.dirname(sourcePath));
  const targetRoot = await root(path.dirname(targetPath));
  let published: RootCopyPublicationReceipt | undefined;
  const copy = (clone: "auto" | "always" | "never") =>
    targetRoot.copyIn(
      path.basename(targetPath),
      {
        relativePath: path.basename(sourcePath),
        root: {
          stat: (relativePath) => sourceRoot.stat(relativePath),
          open: async (relativePath, options) => {
            const opened = await sourceRoot.open(relativePath, options);
            try {
              if (!sameFileIdentity(expectedIdentity, await opened.handle.stat({ bigint: true }))) {
                throw new Error(`SQLite copy source changed: ${sourcePath}`);
              }
              return opened;
            } catch (error) {
              await opened.handle.close();
              throw error;
            }
          },
        },
      },
      {
        clone,
        ...(beforeByteCopy ? { maxBytes: Number(expectedIdentity.size) } : {}),
        // Reading an admitted alias is safe: this creates an independent inode.
        // Recovery inventories keep their stricter one-link admission policy.
        sourceHardlinks: "allow",
        overwrite: false,
        mode: 0o600,
        durable: true,
        onDestinationPublished: (receipt) => {
          published = receipt;
        },
      },
    );
  let method: "clone" | "copy" | undefined;
  if (beforeByteCopy || onCopy) {
    try {
      // Explicit fallback preserves space admission and reports the actual mode.
      await copy("always");
      method = "clone";
    } catch (error) {
      if (
        published ||
        !(error instanceof FsSafeError) ||
        error.details?.cleanup === "failed" ||
        !(
          error.code === "unsupported-platform" ||
          (error.code === "helper-unavailable" &&
            error.message === "native file cloning is unavailable")
        )
      ) {
        throw error;
      }
      await beforeByteCopy?.(Number(expectedIdentity.size));
      await copy("never");
      method = "copy";
    }
  } else {
    await copy("auto");
  }
  if (!published) {
    throw new Error(`SQLite copy was not published: ${targetPath}`);
  }
  if (method) {
    onCopy?.(method);
  }
  return published;
}

export class SqliteSourceChangedError extends Error {}

export function copyPinnedSqliteFile(
  sourcePath: string,
  identity: BigIntStats,
  targetPath: string,
  clone: "auto" | "always",
) {
  // Sidecars may be aliases. Resolve only after pinning, then bind the guarded
  // copy to that inode and revalidate the original pathname before acceptance.
  let physicalSourcePath: string;
  try {
    physicalSourcePath = fs.realpathSync.native(sourcePath);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      throw new SqliteSourceChangedError(`SQLite source disappeared: ${sourcePath}`, {
        cause: error,
      });
    }
    throw error;
  }
  // Helper failures can describe either path; retrying them could hide a
  // destination or cleanup failure behind a simultaneous source change.
  return copyRootFileSync({
    source: { rootPath: path.dirname(physicalSourcePath), absolutePath: physicalSourcePath },
    destination: { rootPath: path.dirname(targetPath), absolutePath: targetPath },
    expectedSourceIdentity: identity,
    sourceHardlinks: "allow",
    clone,
    mode: 0o600,
  });
}

export function clonePinnedSqliteWal(
  sourcePath: string,
  identity: BigIntStats,
  targetPath: string,
) {
  try {
    return copyPinnedSqliteFile(sourcePath, identity, targetPath, "always");
  } catch (error) {
    // Failed cleanup is not a capability miss: the streaming path needs an
    // absent destination, and must never conceal an unsettled clone failure.
    if (
      error instanceof FsSafeError &&
      error.code === "unsupported-platform" &&
      error.details?.cleanup !== "failed"
    ) {
      return undefined;
    }
    throw error;
  }
}
