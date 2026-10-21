import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { createPluginNativeAdmission } from "./plugin-native-admission.js";
import type { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import { copyPluginSourceFile } from "./plugin-source-file.js";
import {
  readPluginSourceDirectory,
  pluginSourceInputIdentity,
} from "./plugin-source-verification.js";

/** Publish only verified dependency links; real nested installs keep their own bytes. */
export function linkPluginGenerationDependency(link: string, target: string): boolean {
  const entry = fs.lstatSync(link, { throwIfNoEntry: false });
  if (entry && !entry.isSymbolicLink()) {
    return false;
  }
  if (
    entry &&
    path.resolve(path.dirname(link), fs.readlinkSync(link)) === target &&
    fs.statSync(link, { throwIfNoEntry: false })
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (entry) {
      // MoveFileEx cannot replace a directory junction. Unlink only the reparse point.
      if (!fs.lstatSync(link).isSymbolicLink()) {
        throw new Error(`Dependency link became a real entry: ${link}`);
      }
      fs.unlinkSync(link);
    }
    fs.symlinkSync(target, link, "junction");
  } else {
    const staged = `${link}.${randomUUID()}.tmp`;
    try {
      fs.symlinkSync(path.relative(path.dirname(link), target), staged, "junction");
      fs.renameSync(staged, link);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }
  if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target)) {
    throw new Error(`Dependency link does not resolve to its captured target: ${link}`);
  }
  if (entry) {
    process.emitWarning(`Replacing plugin dependency link ${link}`);
  }
  return true;
}

export function createPluginSourceLinkCapture() {
  const links = new Set<string>();
  return {
    defer(filename: string, root: string, source = filename): boolean {
      if (
        !fs.lstatSync(filename).isSymbolicLink() ||
        isPathInside(root, fs.realpathSync(filename))
      ) {
        return false;
      }
      links.add(source);
      return true;
    },
    contains: (filename: string) => [...links].some((link) => isPathInside(link, filename)),
  };
}

/** Capture each selected package file once, retaining its source facts and ordered receipt. */
export function createPluginGenerationFileCapture({
  boundary,
  destination,
  directory,
  outputRoot,
  capturedPaths,
  originalSources,
  hardlinkedSources,
  sourceCapture,
  sourceLinks,
  deferExternalLinks,
  nativeAdmission,
  receipt,
  onPackageMetadata,
}: {
  boundary: string;
  destination: string;
  directory: string;
  outputRoot?: string;
  capturedPaths: Map<string, string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  sourceCapture: Pick<
    ReturnType<typeof createPluginSourceCapture>,
    "inputs" | "pendingInputs" | "additions"
  >;
  sourceLinks: ReturnType<typeof createPluginSourceLinkCapture>;
  deferExternalLinks: boolean;
  nativeAdmission: ReturnType<typeof createPluginNativeAdmission>;
  receipt: ReturnType<typeof createPluginGenerationReceipt>;
  onPackageMetadata: (source: string, target: string) => void;
}) {
  const { inputs, pendingInputs, additions } = sourceCapture;
  const ancestors = new Set<string>();
  const copy = (source: string, target: string) => {
    // Metadata can precede its package body; promotion never replaces those captured bytes.
    if (capturedPaths.get(path.resolve(source)) === target) {
      return;
    }
    const prepared = nativeAdmission.resolvePreparedSource(source);
    const input = prepared?.path ?? source;
    const inputBoundary = prepared?.boundary ?? boundary;
    const real = fs.realpathSync(input);
    const retainedNative = nativeAdmission.isRetainedReference(source, real);
    if (!isPathInside(inputBoundary, real) && !retainedNative) {
      throw new Error(
        `Plugin source link leaves its package: ${path.relative(boundary, source)}. Declare shared code as a package dependency.`,
      );
    }
    if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
      return;
    }
    const stat = fs.statSync(real, { bigint: true });
    const captured = capturedPaths.get(real);
    const recordContent = (
      contentHash: string,
      sizeBytes = 0,
      native = false,
      identity = pluginSourceInputIdentity(stat),
      admittedBoundary = inputBoundary,
    ) => {
      if (!captured) {
        // Filesystem ticks can hide edits; aliases retain their first captured content facts.
        inputs.set(real, {
          identity,
          contentHash,
          sizeBytes,
          directory: stat.isDirectory(),
          boundary: admittedBoundary,
          ...(native ? { native: true } : {}),
        });
        pendingInputs.add(real);
      }
    };
    capturedPaths.set(path.resolve(source), target);
    originalSources.set(target, path.resolve(source));
    // SDK companion loaders receive copied paths; those exact aliases retain this owner.
    capturedPaths.set(target, target);
    if (!capturedPaths.has(real)) {
      capturedPaths.set(real, target);
    }
    // Receipts cover copied empty directories as well as file contents.
    receipt.marker(
      `${stat.isDirectory() ? "directory" : "file"}\0${path.relative(destination, target)}\0`,
    );
    if (stat.isDirectory()) {
      if (ancestors.has(real)) {
        throw new Error(`Plugin source contains a directory cycle: ${source}`);
      }
      ancestors.add(real);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const { names, contentHash } = readPluginSourceDirectory(real);
      recordContent(contentHash);
      for (const name of names) {
        if (
          !(
            deferExternalLinks &&
            !nativeAdmission.isRetainedReference(path.join(source, name)) &&
            sourceLinks.defer(path.join(input, name), inputBoundary, path.join(source, name))
          )
        ) {
          copy(path.join(source, name), path.join(target, name));
        }
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      if (stat.nlink > 1n) {
        hardlinkedSources.add(target);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const native = nativeAdmission.materialize(real, inputBoundary, target, stat, source);
      if (native) {
        nativeAdmission.reconcileSourceInputs(inputs);
      } else if (captured) {
        // A second filename for a prefetched entry retains its first bytes and source identity.
        fs.copyFileSync(captured, target, fs.constants.COPYFILE_FICLONE);
      } else {
        copyPluginSourceFile(real, inputBoundary, target);
        fs.chmodSync(target, 0o600 | Number(stat.mode & 0o100n));
      }
      receipt.file({
        target: native?.path ?? target,
        boundary: native?.boundary ?? directory,
        sizeBytes: Number(stat.size),
        native: native !== undefined,
        prepared: native?.content,
        onContent: (content) => {
          native?.record(content);
          recordContent(
            content.contentHash,
            content.sizeBytes,
            native !== undefined,
            native?.sourceIdentity,
            native?.sourceBoundary ?? inputBoundary,
          );
        },
      });
      additions.add(target);
      if (path.basename(target) === "package.json") {
        onPackageMetadata(source, target);
      }
    } else {
      throw new Error(`Plugin build input is not a regular file: ${source}`);
    }
  };
  return copy;
}
