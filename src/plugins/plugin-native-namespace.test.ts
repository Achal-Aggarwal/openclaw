import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginNativeNamespace } from "./plugin-native-namespace.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "hardlinks managed companions only on the capture filesystem (cross-device: %s)",
  (crossDevice) => {
    const root = dirs.make("plugin-native-namespace-device-");
    const sourceDirectory = path.join(root, "source");
    fs.mkdirSync(sourceDirectory);
    const sourceFile = path.join(sourceDirectory, "LICENSE.md");
    fs.writeFileSync(sourceFile, "native companion sentinel");
    const capturedRoot = path.join(root, "captured");
    fs.mkdirSync(capturedRoot);
    if (crossDevice) {
      // Model state on another filesystem: hardlinks there fail with EXDEV.
      const { statSync } = fs;
      vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, options?: object) => {
        const stat = Reflect.apply(statSync, fs, [file, options]) as fs.BigIntStats | undefined;
        if (stat && file === capturedRoot && typeof stat.dev === "bigint") {
          stat.dev += 1n;
        }
        return stat;
      }) as typeof fs.statSync);
      vi.spyOn(fs, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      });
    }

    capturePluginNativeNamespace({
      sourceDirectory,
      boundary: sourceDirectory,
      capturedRoot,
      managed: true,
    });

    const captured = path.join(capturedRoot, "content", "LICENSE.md");
    expect(fs.readFileSync(captured, "utf8")).toBe("native companion sentinel");
    expect(fs.lstatSync(captured).isFile()).toBe(true);
    expect(fs.statSync(sourceFile).nlink).toBe(crossDevice ? 1 : 2);
  },
);
