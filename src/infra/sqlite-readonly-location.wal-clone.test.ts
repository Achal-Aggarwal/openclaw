import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrictSync } from "./directory-walk.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  prepareSqliteReadOnlyLocationSyncInProcess,
  prepareSqliteReadOnlyCopyInProcess,
} from "./sqlite-readonly-location.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return { ...actual, copyRootFileSync: vi.fn(actual.copyRootFileSync) };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    vi.mocked(fsSafeAdvanced.copyRootFileSync).mockImplementation(copyFile);
    cleanup();
  });
});

const { copyRootFileSync: copyFile } = await vi.importActual<
  typeof import("@openclaw/fs-safe/advanced")
>("@openclaw/fs-safe/advanced");

function createFixture(bytes: Buffer) {
  const sourceRoot = tempDirs.make("openclaw-readonly-copy-source-");
  const sourcePath = path.join(sourceRoot, "source.sqlite");
  const stagingRoot = tempDirs.make("openclaw-readonly-copy-staging-");
  fs.writeFileSync(sourcePath, bytes, { mode: 0o600 });
  return {
    sourcePath,
    sourceRoot,
    stagingRoot,
    prepare: () => prepareSqliteReadOnlyLocationSyncInProcess(sourcePath, stagingRoot),
  };
}

function afterPrivateCopy(stagingRoot: string, operation: (pathname: string) => void): void {
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    // Native cloning returns an owned fd without going through fs.openSync.
    const copied = fs.fstatSync(descriptor, { bigint: true });
    const target = listDirectoryTreeStrictSync(stagingRoot)
      .map((walkEntry) => walkEntry.relativePath)
      .map((entry) => path.join(stagingRoot, entry))
      .find((pathname) => {
        const current = fs.statSync(pathname, { bigint: true });
        return current.isFile() && current.dev === copied.dev && current.ino === copied.ino;
      });
    if (target) {
      operation(target);
    }
  });
}

function snapshotSqliteFamily(pathname: string) {
  return ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
    const file = pathname + suffix;
    return fs.existsSync(file)
      ? [{ suffix, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }]
      : [];
  });
}

function createFrozenWalFixture() {
  const fixture = createFixture(Buffer.alloc(0));
  const writer = new (requireNodeSqlite().DatabaseSync)(fixture.sourcePath);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE entries (value TEXT);
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO entries VALUES ('committed');
    `);
    const main = fs.readFileSync(fixture.sourcePath);
    const committed = fs.readFileSync(`${fixture.sourcePath}-wal`);
    writer.exec("INSERT INTO entries VALUES (hex(zeroblob(16384)))");
    const extended = fs.readFileSync(`${fixture.sourcePath}-wal`);
    writer.close();
    fs.writeFileSync(fixture.sourcePath, main);
    fs.writeFileSync(`${fixture.sourcePath}-wal`, committed);
    return { ...fixture, main, committed, extended };
  } finally {
    if (writer.isOpen) {
      writer.close();
    }
  }
}

// Exercise the clone receipt contract even on CI filesystems without reflinks.
// Native APFS/Btrfs cloning is measured separately; these bytes and fds are real.
function mockWalClone(mode: "clone" | "stream", onCloned?: () => void) {
  const copy = copyFile;
  return vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
    if (options.clone !== "always" || !options.destination.absolutePath.endsWith("-wal")) {
      return copy(options);
    }
    if (mode === "stream") {
      throw new FsSafeError("unsupported-platform", "fixture filesystem cannot clone");
    }
    const target = copy({ ...options, clone: "never" });
    onCloned?.();
    return target;
  });
}

function readSnapshotBytes(fixture: ReturnType<typeof createFixture>) {
  const entries = fs.readdirSync(fixture.stagingRoot);
  const prepared = fixture.prepare();
  try {
    return ["", "-wal"].map((suffix) => fs.readFileSync(prepared.location + suffix));
  } finally {
    expect(prepared.cleanup()).toBe(true);
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual(entries);
  }
}

it.each(["committed", "corrupt tail", "uncommitted tail"] as const)(
  "clones the same committed bytes as streaming with a %s WAL",
  (scenario) => {
    const fixture = createFrozenWalFixture();
    const walPath = `${fixture.sourcePath}-wal`;
    if (scenario !== "committed") {
      const frameBytes = fixture.committed.readUInt32BE(8) + 24;
      const tail = Buffer.from(
        scenario === "corrupt tail"
          ? fixture.extended
          : fixture.extended.subarray(0, fixture.extended.length - frameBytes),
      );
      if (scenario === "corrupt tail") {
        const offset = fixture.committed.length + 24;
        tail.writeUInt8(tail.readUInt8(offset) ^ 0xff, offset);
      }
      fs.writeFileSync(walPath, tail);
    }
    const before = snapshotSqliteFamily(fixture.sourcePath);
    const stream = mockWalClone("stream");
    const expected = readSnapshotBytes(fixture);
    stream.mockRestore();
    expect(expected).toEqual([fixture.main, fixture.committed]);

    const clone = mockWalClone("clone", () => write.mockClear());
    const write = vi.spyOn(fs, "writeSync");
    expect(readSnapshotBytes(fixture)).toEqual(expected);
    // The guarded helper owns the transfer; the WAL validator must not rewrite it.
    expect(write).not.toHaveBeenCalled();
    expect(clone.mock.calls.some(([options]) => options.clone === "always")).toBe(true);
    expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(before);
  },
);

it.skipIf(process.platform === "win32")(
  "clones an admitted WAL alias and excludes an append after its captured bound",
  () => {
    const fixture = createFrozenWalFixture();
    const walPath = `${fixture.sourcePath}-wal`;
    const physicalWal = path.join(fixture.sourceRoot, "retained-wal");
    const stream = mockWalClone("stream");
    const expected = readSnapshotBytes(fixture);
    stream.mockRestore();
    fs.renameSync(walPath, physicalWal);
    fs.symlinkSync(physicalWal, walPath);
    const copy = copyFile;
    let appended = false;
    vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
      if (options.clone === "always" && options.destination.absolutePath.endsWith("-wal")) {
        expect(options.source.absolutePath).toBe(fs.realpathSync.native(physicalWal));
        appended = true;
        fs.appendFileSync(physicalWal, fixture.extended.subarray(fixture.committed.length));
        return copy({ ...options, clone: "never" });
      }
      return copy(options);
    });

    expect(readSnapshotBytes(fixture)).toEqual(expected);
    expect(appended).toBe(true);
    expect(fs.readFileSync(physicalWal)).toEqual(fixture.extended);
    expect(fs.readlinkSync(walPath)).toBe(physicalWal);
    expect(fs.readFileSync(fixture.sourcePath)).toEqual(fixture.main);
  },
);

it("refuses a same-size WAL replacement between pinning and cloning", () => {
  const fixture = createFrozenWalFixture();
  const walPath = `${fixture.sourcePath}-wal`;
  const stream = mockWalClone("stream");
  expect(readSnapshotBytes(fixture)).toEqual([fixture.main, fixture.committed]);
  stream.mockRestore();
  const copy = copyFile;
  const wait = vi.spyOn(Atomics, "wait");
  let replaced = false;
  vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
    if (options.clone === "always" && options.destination.absolutePath.endsWith("-wal")) {
      replaced = true;
      fs.renameSync(walPath, `${walPath}.original`);
      fs.writeFileSync(walPath, fixture.committed);
      return copy({ ...options, clone: "never" });
    }
    return copy(options);
  });
  expect(fixture.prepare).toThrow(/identity changed/);
  expect(replaced).toBe(true);
  expect(wait).not.toHaveBeenCalled();
  expect(fs.readFileSync(walPath)).toEqual(fixture.committed);
  expect(fs.readFileSync(`${walPath}.original`)).toEqual(fixture.committed);
  expect(fs.readFileSync(fixture.sourcePath)).toEqual(fixture.main);
  expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
});

it("retries a checkpoint and WAL reset during cloning before accepting the new generation", () => {
  const fixture = createFrozenWalFixture();
  const writer = new (requireNodeSqlite().DatabaseSync)(fixture.sourcePath);
  let reset = false;
  let afterReset = snapshotSqliteFamily(fixture.sourcePath);
  const clone = mockWalClone("clone", () => {
    if (!reset) {
      reset = true;
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE entries SET value = 'after-reset'");
      afterReset = snapshotSqliteFamily(fixture.sourcePath);
    }
  });
  const wait = vi.spyOn(Atomics, "wait");
  let prepared: ReturnType<typeof fixture.prepare> | undefined;
  try {
    prepared = fixture.prepare();
    expect(reset).toBe(true);
    expect(wait).toHaveBeenCalledTimes(1);
    clone.mockRestore();
    mockWalClone("stream");
    expect(["", "-wal"].map((suffix) => fs.readFileSync(prepared!.location + suffix))).toEqual(
      readSnapshotBytes(fixture),
    );
    using snapshot = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM entries").all()).toEqual([{ value: "after-reset" }]);
    expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(afterReset);
  } finally {
    prepared?.cleanup();
    writer.close();
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
  }
});

it.each(["clone", "clone cleanup", "truncate", "fsync", "close"] as const)(
  "cleans the private WAL and retains the source after a %s failure",
  (failure) => {
    const fixture = createFrozenWalFixture();
    const before = snapshotSqliteFamily(fixture.sourcePath);
    const stream = mockWalClone("stream");
    expect(readSnapshotBytes(fixture)).toEqual([fixture.main, fixture.committed]);
    stream.mockRestore();
    const error = new FsSafeError(
      failure === "clone cleanup" ? "unsupported-platform" : "helper-failed",
      `WAL ${failure} failed`,
      failure === "clone cleanup" ? { details: { cleanup: "failed" } } : undefined,
    );
    const copy = copyFile;
    let targetFd: number | undefined;
    let injected = false;
    vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
      if (options.clone !== "always" || !options.destination.absolutePath.endsWith("-wal")) {
        return copy(options);
      }
      if (failure === "clone" || failure === "clone cleanup") {
        injected = true;
        throw error;
      }
      const target = copy({ ...options, clone: "never" });
      targetFd = target.fd;
      return {
        ...target,
        close() {
          target.close();
          if (failure === "close") {
            injected = true;
            throw error;
          }
        },
      };
    });
    if (failure === "truncate") {
      const truncate = fs.ftruncateSync.bind(fs);
      vi.spyOn(fs, "ftruncateSync").mockImplementation((descriptor, length) => {
        if (descriptor === targetFd) {
          injected = true;
          throw error;
        }
        truncate(descriptor, length);
      });
    } else if (failure === "fsync") {
      const fsync = fs.fsyncSync.bind(fs);
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        if (descriptor === targetFd) {
          injected = true;
          throw error;
        }
        fsync(descriptor);
      });
    }
    const wait = vi.spyOn(Atomics, "wait");
    expect(fixture.prepare).toThrow(error);
    expect(injected).toBe(true);
    expect(wait).not.toHaveBeenCalled();
    if (targetFd !== undefined) {
      const closedDescriptor = targetFd;
      expect(() => fs.fstatSync(closedDescriptor)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
    }
    expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(before);
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
  },
);

it("rejects a reset WAL paired with checkpoint-restored main bytes during native copying", async () => {
  const fixture = createFixture(Buffer.alloc(0));
  const sqlite = requireNodeSqlite();
  const writer = new sqlite.DatabaseSync(fixture.sourcePath);
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
  try {
    writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE left_value (value TEXT);
        CREATE TABLE right_value (value TEXT);
        INSERT INTO left_value VALUES ('A');
        INSERT INTO right_value VALUES ('A');
        PRAGMA wal_checkpoint(PASSIVE);
      `);
    const mainBefore = fs.readFileSync(fixture.sourcePath);
    let reset = false;
    let restored = false;
    let sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
    const afterCopy = (target: string) => {
      if (!reset && target.endsWith(".partial")) {
        reset = true;
        writer.exec(`
            UPDATE left_value SET value = 'B';
            PRAGMA wal_checkpoint(TRUNCATE);
            UPDATE right_value SET value = 'C';
          `);
      } else if (reset && !restored && target.endsWith("-wal")) {
        restored = true;
        const copiedWal = fs.readFileSync(target);
        // Restore both pages in one commit: A/C must never be a committed state.
        writer.exec(`
            BEGIN IMMEDIATE;
            UPDATE left_value SET value = 'A';
            UPDATE right_value SET value = 'A';
            COMMIT;
            PRAGMA wal_checkpoint(PASSIVE);
          `);
        expect(fs.readFileSync(fixture.sourcePath)).toEqual(mainBefore);
        expect(fs.readFileSync(`${fixture.sourcePath}-wal`).subarray(0, copiedWal.length)).toEqual(
          copiedWal,
        );
        sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
      }
    };
    afterPrivateCopy(fixture.stagingRoot, afterCopy);
    __setFsSafeTestHooksForTest({
      beforeRootStatObservation: (pathname) => {
        if (pathname === fixture.sourceRoot) {
          afterCopy("database.sqlite.partial");
        }
      },
    });

    prepared = await prepareSqliteReadOnlyCopyInProcess(fixture.sourcePath, fixture.stagingRoot);
    expect(reset).toBe(true);
    expect(restored).toBe(true);
    const streaming = mockWalClone("stream");
    const expectedBytes = readSnapshotBytes(fixture);
    streaming.mockRestore();
    expect(["", "-wal"].map((suffix) => fs.readFileSync(prepared!.location + suffix))).toEqual(
      expectedBytes,
    );
    using snapshot = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
    expect(snapshot.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(
      snapshot
        .prepare(
          "SELECT left_value.value AS left_value, right_value.value AS right_value FROM left_value CROSS JOIN right_value",
        )
        .all(),
    ).toEqual([{ left_value: "A", right_value: "A" }]);
    expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(sourceAfterWrites);
  } finally {
    if (prepared) {
      expect(prepared.cleanup()).toBe(true);
    }
    writer.close();
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
  }
});
