import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packNodeRuntime, restoreNodeRuntime } from "../../scripts/ci-node-runtime-artifact.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = temps.make("node-runtime-artifact-");
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, "source.txt"), "source");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  for (const directory of [
    "dist/plugin-sdk",
    "dist-runtime/extensions/example",
    "packages/example/dist",
    "node_modules",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "dist/entry.js"), "export const built = true;\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(root, "dist/plugin-sdk/qa-runtime.js"), "export {};\n");
  fs.writeFileSync(path.join(root, "dist-runtime/extensions/example/index.js"), "runtime");
  fs.writeFileSync(path.join(root, "packages/example/dist/index.js"), "package");
  fs.writeFileSync(path.join(root, "node_modules/untouched"), "dependency");
  const stamp = JSON.stringify({
    head: revision,
    inputsClean: true,
    inputSignature: "producer-signature",
  });
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    fs.writeFileSync(path.join(root, "dist", name), stamp);
  }
  return { root, revision, directory: path.join(root, "artifact"), stamp };
}

describe.skipIf(process.platform !== "linux")("same-run Node runtime artifact", () => {
  it("round-trips complete runtime outputs without source/dependencies and keeps producer stamps", () => {
    const f = fixture();
    const packed = packNodeRuntime(f.root, f.directory, f.revision, "private-qa");
    expect(packed.bytes).toBeGreaterThan(0);
    const listed = execFileSync("tar", ["-tzf", path.join(f.directory, "runtime.tgz")], {
      encoding: "utf8",
    });
    expect(listed).not.toContain("node_modules");
    expect(listed).not.toContain("source.txt");
    fs.writeFileSync(path.join(f.root, "dist/stale.js"), "stale");
    restoreNodeRuntime(f.root, f.directory, f.revision, "private-qa");
    expect(fs.existsSync(path.join(f.root, "dist/stale.js"))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, "dist/entry.js"), "utf8")).toContain("built");
    expect(fs.statSync(path.join(f.root, "dist/entry.js")).mode & 0o111).toBe(0o111);
    expect(
      fs.readFileSync(path.join(f.root, "dist-runtime/extensions/example/index.js"), "utf8"),
    ).toBe("runtime");
    expect(fs.readFileSync(path.join(f.root, "packages/example/dist/index.js"), "utf8")).toBe(
      "package",
    );
    expect(fs.readFileSync(path.join(f.root, "dist/.buildstamp"), "utf8")).toBe(f.stamp);
    expect(fs.readFileSync(path.join(f.root, "node_modules/untouched"), "utf8")).toBe("dependency");
  });

  it("rejects a different source, runtime or damaged archive before replacing outputs", () => {
    const f = fixture();
    packNodeRuntime(f.root, f.directory, f.revision, "private-qa");
    const manifestPath = path.join(f.directory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const [key, value] of [
      ["revision", "0".repeat(40)],
      ["node", "v0.0.0"],
      ["mode", "runtime"],
    ] as const) {
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, [key]: value }));
      expect(() => restoreNodeRuntime(f.root, f.directory, f.revision, "private-qa")).toThrow(
        "mismatch",
      );
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.appendFileSync(path.join(f.directory, "runtime.tgz"), "corruption");
    expect(() => restoreNodeRuntime(f.root, f.directory, f.revision, "private-qa")).toThrow(
      "checksum",
    );
    expect(fs.readFileSync(path.join(f.root, "dist/.buildstamp"), "utf8")).toBe(f.stamp);
  });
});
