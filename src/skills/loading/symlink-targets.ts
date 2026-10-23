import path from "node:path";
import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  safeRealpathSync,
} from "../../infra/boundary-path.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveUserPath } from "../../utils.js";

export function resolveAllowedSkillSymlinkTargetRealPaths(config?: OpenClawConfig): string[] {
  const targetPaths = normalizeTrimmedStringList(config?.skills?.load?.allowSymlinkTargets)
    .map((dir) => tryRealpath(resolveUserPath(dir)))
    .filter((dir): dir is string => Boolean(dir));
  return uniqueStrings(targetPaths);
}

export function findContainingAllowedSkillSymlinkTarget(
  rootRealPaths: readonly string[],
  candidateRealPath: string,
): string | null {
  const resolvedCandidate = path.resolve(candidateRealPath);
  for (const rootRealPath of rootRealPaths) {
    const resolvedRoot = path.resolve(rootRealPath);
    if (isPathInside(resolvedRoot, resolvedCandidate)) {
      return resolvedRoot;
    }
  }
  return null;
}

export function tryRealpath(filePath: string): string | null {
  try {
    // Native realpath restores on-disk casing; fs-safe then requires an existing path.
    return safeRealpathSync(resolveIdentityPathViaExistingAncestorSync(filePath));
  } catch {
    return null;
  }
}
