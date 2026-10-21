import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

function writeTree(root: string, files: Record<string, string | object>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
}

function fixture() {
  const root = temp.make("capture-dependency-links-");
  writeTree(root, {
    "package.json": { name: "fixture", dependencies: { dependency: "*", sibling: "*" } },
    "index.cjs": "exports.ready = true;",
    "node_modules/dependency/package.json": { name: "dependency", main: "index.cjs" },
    "node_modules/dependency/index.cjs": "module.exports = 'captured dependency';",
    "node_modules/sibling/package.json": { name: "sibling", main: "index.cjs" },
    "node_modules/sibling/index.cjs": "module.exports = 'unaffected sibling';",
  });
  const artifact = capturePluginGenerationArtifact(root, path.join(root, "index.cjs"), (run) =>
    run(),
  );
  cleanups.push(artifact.dispose);
  const entry = artifact.resolve(path.join(root, "index.cjs"));
  const link = path.join(artifact.rootDir, "node_modules", "dependency");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  return { artifact, entry, link, root };
}

it.each(["relative symlink", "absolute junction"])(
  "repairs a dangling %s before loading captured dependencies",
  (layout) => {
    const { artifact, entry, link, root } = fixture();
    const disposed = path.join(root, "disposed-capture");
    fs.symlinkSync(
      layout === "absolute junction" ? disposed : path.relative(path.dirname(link), disposed),
      link,
      layout === "absolute junction" ? "junction" : "dir",
    );
    expect(fs.existsSync(link)).toBe(false);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const rename = fs.renameSync;
    let publishedAtomically = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === link) {
        // Replacement is ready while the original entry still exists, including a junction.
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(String(from), "index.cjs"), "utf8")).toContain(
          "captured dependency",
        );
        publishedAtomically = true;
      }
      rename(from, to);
    });

    const additions = artifact.prepareDependency(entry, "dependency");
    expect(additions).toContain(link);
    expect(publishedAtomically).toBe(process.platform !== "win32");
    expect(createRequire(entry)("dependency")).toBe("captured dependency");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Replacing"));
    artifact.prepareNativeScopes(entry);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(createRequire(entry)("sibling")).toBe("unaffected sibling");
  },
);

it("replaces a live link to another target without changing that target", () => {
  const { artifact, entry, link, root } = fixture();
  const previous = path.join(root, "previous");
  writeTree(previous, {
    "package.json": { main: "index.cjs" },
    "index.cjs": "module.exports = 'previous dependency';",
  });
  fs.symlinkSync(previous, link, "junction");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

  artifact.prepareDependency(entry, "dependency");
  expect(createRequire(entry)("dependency")).toBe("captured dependency");
  expect(fs.readFileSync(path.join(previous, "index.cjs"), "utf8")).toContain(
    "previous dependency",
  );
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("Replacing"));
});

it("preserves a real dependency directory", () => {
  const { artifact, entry, link } = fixture();
  writeTree(link, {
    "package.json": { main: "index.cjs" },
    "index.cjs": "module.exports = 'nested install';",
  });
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

  artifact.prepareDependency(entry, "dependency");
  expect(fs.lstatSync(link).isDirectory()).toBe(true);
  expect(createRequire(entry)("dependency")).toBe("nested install");
  expect(warning).not.toHaveBeenCalled();
});

it.each(["EPERM", "EISDIR"])(
  "repairs Windows junctions when rename cannot replace directories (%s)",
  (code) => {
    const { artifact, entry, link, root } = fixture();
    artifact.prepareDependency(entry, "dependency");
    artifact.prepareDependency(entry, "sibling");
    const target = fs.realpathSync(link);
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, "disposed-capture"), link, "junction");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === link && fs.lstatSync(link, { throwIfNoEntry: false })) {
        throw Object.assign(new Error("cannot replace a directory junction"), { code });
      }
      rename(from, to);
    });
    const symlink = fs.symlinkSync;
    let recreated = false;
    vi.spyOn(fs, "symlinkSync").mockImplementation((destination, filename, type) => {
      if (filename === link) {
        expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
        recreated = true;
      }
      symlink(destination, filename, type);
    });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    withMockedPlatform("win32", () => artifact.prepareNativeScopes(entry));
    expect(recreated).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(target);
    expect(createRequire(entry)("dependency")).toBe("captured dependency");
  },
);
