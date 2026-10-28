import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import {
  copyWorkerNativeArchiveCache,
  prepareWorkerDarwinNativeAssets,
} from "../../scripts/lib/fs-safe-worker-native-assets.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const root = await fs.realpath(temp.make("native-archives-"));
  const snapshot = await fs.realpath(temp.make("native-snapshot-"));
  const packageDir = path.join(root, "package");
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, "fs-safe-native.node"), "synthetic-addon");
  const chunks: Buffer[] = [];
  for await (const chunk of tar.create({ cwd: root, gzip: true }, [
    "package/fs-safe-native.node",
  ])) {
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const digest = createHash("sha256").update(integrity).digest("hex");
  const targets = ["darwin-arm64", "darwin-x64"];
  const names = targets.map((target) => "@openclaw/fs-safe-" + target);
  const filenames = targets.map((target) => `${target}-1.2.3-${digest}.tgz`);
  const cache = path.join(root, ".artifacts/worker-native-assets");
  await fs.mkdir(cache, { recursive: true });
  for (const filename of filenames) {
    await fs.writeFile(path.join(cache, filename), bytes);
  }
  const manifest = path.join(root, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      optionalDependencies: Object.fromEntries(names.map((name) => [name, "1.2.3"])),
    }),
  );
  await fs.writeFile(
    path.join(snapshot, "pnpm-lock.yaml"),
    JSON.stringify({
      packages: Object.fromEntries(
        names.map((name) => [name + "@1.2.3", { resolution: { integrity } }]),
      ),
    }),
  );
  const fetch = vi.fn(() => {
    throw new Error("Offline input must not fetch");
  });
  vi.stubGlobal("fetch", fetch);
  return {
    root,
    snapshot,
    cache,
    manifest,
    bytes,
    integrity,
    names,
    filenames,
    fetch,
    copy: () => copyWorkerNativeArchiveCache(root, snapshot, manifest),
  };
}

it("admits only pinned verified archives and the build consumes them without network", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cache, "unrelated-private.tgz"), "must not copy");
  await fs.symlink(f.manifest, path.join(f.cache, "unrelated-link"));
  const receipts = await f.copy();
  expect(await fs.readdir(path.join(f.snapshot, ".artifacts/worker-native-assets"))).toEqual(
    f.filenames,
  );
  expect(receipts).toEqual(
    f.names.map((name) => ({
      name,
      version: "1.2.3",
      integrity: f.integrity,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
    })),
  );
  const assets = await prepareWorkerDarwinNativeAssets(f.snapshot, f.manifest);
  expect(assets.map((asset) => asset.source.toString())).toEqual([
    "synthetic-addon",
    "synthetic-addon",
  ]);
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(["missing", "corrupt", "mismatched-pin", "symlink", "ancestor-symlink"])(
  "refuses %s archives before copying any bytes",
  async (invalid) => {
    const f = await fixture();
    const selected = path.join(f.cache, f.filenames[0]!);
    if (invalid === "missing") {
      await fs.unlink(selected);
    } else if (invalid === "corrupt") {
      await fs.writeFile(selected, "not the pinned archive");
    } else if (invalid === "mismatched-pin") {
      await fs.writeFile(
        f.manifest,
        JSON.stringify({
          optionalDependencies: Object.fromEntries(f.names.map((name) => [name, "1.2.4"])),
        }),
      );
    } else if (invalid === "symlink") {
      const target = path.join(f.root, "otherwise-valid.tgz");
      await fs.rename(selected, target);
      await fs.symlink(target, selected);
    } else {
      const target = path.join(f.root, "otherwise-valid-cache");
      await fs.rename(f.cache, target);
      await fs.symlink(target, f.cache);
    }
    await expect(f.copy()).rejects.toThrow(
      invalid === "corrupt"
        ? "integrity mismatch"
        : invalid === "mismatched-pin"
          ? "not pinned"
          : "Offline worker native archive unavailable",
    );
    await expect(fs.stat(path.join(f.snapshot, ".artifacts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
