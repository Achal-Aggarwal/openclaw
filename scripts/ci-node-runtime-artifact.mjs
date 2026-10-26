#!/usr/bin/env node
// Same-run Linux qaRuntime transport; dependencies stay with each consumer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { refreshLocalBuildStampTimes } from "./lib/local-build-metadata.mts";

const stampNames = [".buildstamp", ".runtime-postbuildstamp"];
function identity(root, revision, mode) {
  assert.match(revision, /^[a-f0-9]{40}$/u, "Expected an exact source revision");
  assert.equal(mode, "private-qa", "The pilot only qualifies private-QA outputs");
  assert.equal(process.platform, "linux", "Runtime pilot artifacts require Linux");
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    revision,
  );
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
  return { revision, mode, platform: process.platform, arch: process.arch, node: process.version };
}
function verifyStamps(root, revision) {
  for (const name of stampNames) {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, "dist", name), "utf8"));
    assert.equal(stamp.head, revision, "Runtime stamp must match the selected source");
    assert.equal(stamp.inputsClean, true, "Runtime must be built from clean inputs");
  }
  assert.ok(fs.existsSync(path.join(root, "dist", "entry.js")), "Missing built entry");
  assert.ok(
    fs.existsSync(path.join(root, "dist", "plugin-sdk", "qa-runtime.js")),
    "Missing private-QA entry",
  );
}
function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function outputRoots(root) {
  const entries = ["dist", "dist-runtime"];
  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, "packages", entry.name, "dist"))) {
      entries.push("packages/" + entry.name + "/dist");
    }
  }
  return entries.toSorted();
}
export function packNodeRuntime(root, directory, revision, mode) {
  const source = identity(root, revision, mode);
  verifyStamps(root, revision);
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, "runtime.tgz");
  const entries = outputRoots(root);
  execFileSync("tar", ["-czf", archive, ...entries], { cwd: root, stdio: "inherit" });
  const manifest = {
    version: 1,
    ...source,
    entries,
    sha256: digest(archive),
    bytes: fs.statSync(archive).size,
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
export function restoreNodeRuntime(root, directory, revision, mode) {
  const source = identity(root, revision, mode);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1, "Unsupported runtime artifact manifest");
  for (const [key, value] of Object.entries(source)) {
    assert.equal(manifest[key], value, "Runtime artifact " + key + " mismatch");
  }
  assert.ok(
    Array.isArray(manifest.entries) &&
      manifest.entries.includes("dist") &&
      manifest.entries.includes("dist-runtime"),
  );
  for (const entry of manifest.entries) {
    assert.match(
      entry,
      /^(?:dist|dist-runtime|packages\/[^/.][^/]*\/dist)$/u,
      "Unexpected output root",
    );
  }
  const archive = path.join(directory, "runtime.tgz");
  assert.equal(digest(archive), manifest.sha256, "Runtime artifact checksum mismatch");
  // Only the same-run trusted producer supplies these ID-bound artifacts.
  // Reject extra roots; the transport must not overwrite source or dependencies.
  const files = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  for (const file of files) {
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."), "Unsafe archive path");
    assert.ok(
      manifest.entries.some((entry) => file === entry || file.startsWith(entry + "/")),
      "Unexpected archive payload",
    );
  }
  for (const entry of manifest.entries) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  execFileSync("tar", ["-xzf", archive], { cwd: root, stdio: "inherit" });
  verifyStamps(root, revision);
  // Preserve producer identity/signatures; only adjust checkout-relative times.
  refreshLocalBuildStampTimes({ cwd: root });
  return manifest;
}
if (import.meta.main) {
  const [operation, target, revision, mode, ...extra] = process.argv.slice(2);
  assert.ok(
    ["pack", "restore"].includes(operation) && target && revision && mode && extra.length === 0,
    "Usage: ci-node-runtime-artifact.mjs <pack|restore> <directory> <SHA> private-qa",
  );
  const result = (operation === "pack" ? packNodeRuntime : restoreNodeRuntime)(
    process.cwd(),
    path.resolve(target),
    revision,
    mode,
  );
  console.log(JSON.stringify(result));
}
