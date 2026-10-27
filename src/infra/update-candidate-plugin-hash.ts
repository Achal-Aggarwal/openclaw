import { hashFileMutationSnapshotSync, type FileMutationMetadata } from "./file-descriptor.js";
import type { UpdateCandidatePluginFileReply } from "./update-candidate-plugin-file.js";
import { createUpdateCandidatePluginPool } from "./update-candidate-plugin-tasks.js";
import { resolveUpdateHashWorkerCount } from "./worker-pool-sizing.js";
import type { WorkerTaskPool } from "./worker-task-pool.js";

export const UPDATE_CANDIDATE_HASH_BATCH_SIZE = 32;

type UpdateCandidatePluginHashFile = {
  filePath: string;
  expected: FileMutationMetadata;
};

export type UpdateCandidatePluginHashRequest = {
  type: "snapshot-hash";
  files: UpdateCandidatePluginHashFile[];
};

export type UpdateCandidatePluginHashReply =
  | { type: "hashed"; sha256: string[] }
  | Extract<UpdateCandidatePluginFileReply, { type: "failed" }>;

export type UpdateCandidatePluginFileHasher = (
  files: UpdateCandidatePluginHashFile[],
) => Promise<string[]>;

/** The inventory owner drains its four-batch read window before retiring these workers. */
export async function withUpdateCandidatePluginFileHashing<T>(
  operation: (hashFile: UpdateCandidatePluginFileHasher) => Promise<T>,
): Promise<T> {
  let files = 0;
  let workers: number | undefined;
  let pool:
    | Promise<WorkerTaskPool<UpdateCandidatePluginHashRequest, UpdateCandidatePluginHashReply>>
    | undefined;
  try {
    return await operation(async (batch) => {
      // Keep the first 1,023 files in-process, including a partial threshold batch.
      const localCount = Math.min(batch.length, Math.max(0, 1023 - files));
      files += batch.length;
      const hashes = batch
        .slice(0, localCount)
        .map(({ filePath, expected }) => hashFileMutationSnapshotSync(filePath, expected));
      const remaining = batch.slice(localCount);
      if (remaining.length === 0) {
        return hashes;
      }
      workers ??= resolveUpdateHashWorkerCount();
      if (workers === 0) {
        return hashes.concat(
          remaining.map(({ filePath, expected }) =>
            hashFileMutationSnapshotSync(filePath, expected),
          ),
        );
      }
      pool ??= createUpdateCandidatePluginPool<
        UpdateCandidatePluginHashRequest,
        UpdateCandidatePluginHashReply
      >(workers);
      // Transfer only lossless fingerprint fields, not a platform Stats instance.
      const reply = await (
        await pool
      ).run(
        {
          type: "snapshot-hash",
          files: remaining.map(({ filePath, expected }) => ({
            filePath,
            expected: {
              dev: expected.dev,
              ino: expected.ino,
              size: expected.size,
              birthtimeNs: expected.birthtimeNs,
              mtimeNs: expected.mtimeNs,
              ctimeNs: expected.ctimeNs,
              mode: expected.mode,
              uid: expected.uid,
              gid: expected.gid,
            },
          })),
        },
        {},
      );
      switch (reply.type) {
        case "failed":
          throw Object.assign(reply.error, {
            ...(reply.code === undefined ? {} : { code: reply.code }),
            ...(reply.details === undefined ? {} : { details: reply.details }),
          });
        case "hashed":
          return hashes.concat(reply.sha256);
        default:
          throw new Error("Unexpected update inventory hash worker reply");
      }
    });
  } finally {
    // No per-file deadline or replay: the inventory drains accepted reads, then
    // joins worker retirement before returning its plan or propagating failure.
    await (await pool)?.close();
  }
}
