import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoSymlinkParents, readFileHandleBounded } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ToolProfileId } from "../agents/tool-policy-shared.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { FsSafeError, root as fsSafeRoot, type OpenResult } from "../infra/fs-safe.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { digestClawBytes } from "./digest.js";
import {
  isCanonicalClawHubPackageName,
  isExactSemVer,
  isSafeClawRelativePath,
} from "./schema-portability.js";
import {
  clawManifestWorkspaceConflictsWithPath,
  parseClawManifest,
  parseClawOpenClawProfile,
  parseLegacyLocalUpdateClawOpenClawProfile,
} from "./schema.js";
import { clawWorkspaceSourceFailure } from "./source-diagnostics.js";
import {
  MAX_CLAW_MANIFEST_BYTES,
  MAX_MANAGED_FILE_BYTES,
  MAX_MANAGED_WORKSPACE_BYTES,
} from "./source-limits.js";
import {
  materializeClawToolProfile,
  resolveClawToolProfileSnapshot,
} from "./tool-profile-consent.js";
import type {
  ClawDiagnostic,
  ClawOpenClawProfile,
  ClawManifest,
  ClawReadResult,
  ClawSourceIdentity,
  ClawWorkspaceSourceSnapshot,
} from "./types.js";
import { parseClawYaml } from "./yaml-document.js";

const MAX_PROFILE_BYTES = 256 * 1024;
const CLAW_PROFILE_PATH = "profiles/openclaw.yml";
const LEGACY_PROFILE_POINTER_KEY = "openclaw.config";
const LEGACY_PROFILE_POINTER_PATH = "$.metadata.openclaw.config";
const CONVENTIONAL_PROFILE_PATH = "$.profiles.openclaw";

function warning(code: string, message: string, path: string): ClawDiagnostic {
  return { level: "warning", code, phase: "parse", path, message };
}

function isToolProfileId(value: string): value is ToolProfileId {
  return resolveClawToolProfileSnapshot({ profile: value }) !== undefined;
}

function migrateLegacyDynamicToolProfile(
  value: unknown,
  parseProfile: typeof parseClawOpenClawProfile,
): unknown {
  const profile = asOptionalRecord(value);
  const agent = asOptionalRecord(profile?.agent);
  const tools = asOptionalRecord(agent?.tools);
  const toolProfile = tools?.profile;
  if (
    !profile ||
    !agent ||
    !tools ||
    typeof toolProfile !== "string" ||
    !isToolProfileId(toolProfile) ||
    tools.allow !== undefined
  ) {
    return value;
  }
  if (toolProfile === "full") {
    return value;
  }
  const validationProbe = parseProfile({
    ...profile,
    agent: {
      ...agent,
      tools: {
        ...tools,
        profile: "minimal",
      },
    },
  });
  if (!validationProbe.ok) {
    return value;
  }
  const validatedTools = validationProbe.profile.agent.tools;
  if (!validatedTools) {
    return value;
  }
  const selection = {
    ...validatedTools,
    profile: toolProfile,
  };
  const migrated = materializeClawToolProfile(
    { tools: selection },
    { allowLegacyDynamicProfile: true },
  );
  return {
    ...profile,
    agent: {
      ...agent,
      tools: migrated.tools,
    },
  };
}

/**
 * Resolves the OpenClaw profile for a package.
 *
 * `profiles/openclaw.yml` is the conventional location. The retired
 * `metadata.openclaw.config` pointer is still read for compatibility with
 * packages published against the released contract; it reports a deprecation
 * warning instead of failing, and only errors when it is malformed or conflicts
 * with a conventional profile.
 */
async function readClawOpenClawProfile(params: {
  packageRoot: string;
  metadata?: Record<string, string>;
  allowLegacyDynamicToolProfile?: boolean;
  allowLegacyLocalUpdateHostSettings?: boolean;
}): Promise<
  | {
      ok: true;
      profile?: ClawOpenClawProfile;
      raw?: Buffer;
      path?: string;
      diagnostics?: ClawDiagnostic[];
    }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageFiles = await fsSafeRoot(params.packageRoot);
  const conventionalExists = await packageFiles.exists(CLAW_PROFILE_PATH);
  const legacyPointer = params.metadata?.[LEGACY_PROFILE_POINTER_KEY];
  const diagnostics: ClawDiagnostic[] = [];
  let declaredPath = CLAW_PROFILE_PATH;
  let diagnosticPath = CONVENTIONAL_PROFILE_PATH;

  if (legacyPointer !== undefined) {
    if (
      legacyPointer.includes("\\") ||
      !isSafeClawRelativePath(legacyPointer) ||
      !/\.ya?ml$/i.test(legacyPointer)
    ) {
      return {
        ok: false,
        diagnostics: [
          fileDiagnostic(
            "invalid_openclaw_profile_path",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} must reference a forward-slash package-relative .yml or .yaml file.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    if (conventionalExists && legacyPointer !== CLAW_PROFILE_PATH) {
      return {
        ok: false,
        diagnostics: [
          fileDiagnostic(
            "conflicting_openclaw_profile_pointer",
            `metadata.${LEGACY_PROFILE_POINTER_KEY} references ${legacyPointer} while ${CLAW_PROFILE_PATH} also exists; keep only ${CLAW_PROFILE_PATH}.`,
            LEGACY_PROFILE_POINTER_PATH,
          ),
        ],
      };
    }
    declaredPath = legacyPointer;
    diagnosticPath = LEGACY_PROFILE_POINTER_PATH;
    diagnostics.push(
      warning(
        "deprecated_openclaw_profile_pointer",
        `metadata.${LEGACY_PROFILE_POINTER_KEY} is deprecated; move the profile to ${CLAW_PROFILE_PATH} and remove the metadata entry.`,
        LEGACY_PROFILE_POINTER_PATH,
      ),
    );
  } else if (!conventionalExists) {
    return { ok: true };
  }

  let raw: Buffer;
  let text: string;
  try {
    const read = await packageFiles.read(declaredPath, {
      hardlinks: "reject",
      maxBytes: MAX_PROFILE_BYTES,
      symlinks: "reject",
    });
    raw = read.buffer;
    text = decodeUtf8Input(raw, declaredPath);
  } catch (error) {
    const unsafe =
      error instanceof FsSafeError &&
      (error.code === "hardlink" || error.code === "symlink" || error.code === "path-mismatch");
    const tooLarge = error instanceof FsSafeError && error.code === "too-large";
    return {
      ok: false,
      diagnostics: [
        fileDiagnostic(
          unsafe
            ? "openclaw_profile_unsafe"
            : tooLarge
              ? "openclaw_profile_too_large"
              : "openclaw_profile_read_failed",
          unsafe
            ? "The OpenClaw profile must be a regular, non-symlinked, non-hardlinked file."
            : tooLarge
              ? `The OpenClaw profile exceeds ${MAX_PROFILE_BYTES} bytes.`
              : `Could not read ${declaredPath}: ${(error as Error).message}`,
          diagnosticPath,
        ),
      ],
    };
  }

  const yaml = parseClawYaml(
    text.startsWith("\uFEFF") ? text.slice(1) : text,
    declaredPath,
    "profile",
  );
  if (!yaml.ok) {
    return yaml;
  }
  const parseProfile = params.allowLegacyLocalUpdateHostSettings
    ? parseLegacyLocalUpdateClawOpenClawProfile
    : parseClawOpenClawProfile;
  const migration = params.allowLegacyDynamicToolProfile
    ? migrateLegacyDynamicToolProfile(yaml.value, parseProfile)
    : yaml.value;
  const parsed = parseProfile(migration);
  if (!parsed.ok) {
    // Only the released host-field shape gets migration guidance; other schema errors stay exact.
    const legacy = params.allowLegacyLocalUpdateHostSettings
      ? undefined
      : parseLegacyLocalUpdateClawOpenClawProfile(migration);
    if (legacy?.ok) {
      const legacyFields = legacy.diagnostics
        .filter(
          (entry) =>
            entry.code === "legacy_openclaw_model_ignored" ||
            entry.code === "legacy_openclaw_subagents_ignored",
        )
        .map((entry) => entry.path.slice(2));
      if (legacyFields.length > 0) {
        return {
          ok: false,
          diagnostics: [
            {
              level: "error",
              code: "legacy_openclaw_profile_requires_conversion",
              phase: "schema",
              path: `${diagnosticPath}.agent`,
              message: `Released-v1 OpenClaw profile contains ${legacyFields.join(" and ")}. Copy the package and remove these fields from ${declaredPath}; configure model and delegation on the host, then run claws add --dry-run for a fresh consent plan.`,
            },
          ],
        };
      }
    }
    return {
      ok: false,
      diagnostics: parsed.diagnostics.map((entry) => ({
        ...entry,
        path: `${diagnosticPath}${entry.path.slice(1)}`,
      })),
    };
  }
  const profileDiagnostics = parsed.diagnostics.map((entry) => ({
    ...entry,
    path: `${diagnosticPath}${entry.path.slice(1)}`,
  }));
  const allDiagnostics = [...diagnostics, ...profileDiagnostics];
  return {
    ok: true,
    profile: parsed.profile,
    raw,
    path: declaredPath,
    ...(allDiagnostics.length > 0 ? { diagnostics: allDiagnostics } : {}),
  };
}

type PackageJson = {
  name: string;
  version: string;
  openclaw: { claw: string };
};

type ResolvedClawSource = Omit<ClawSourceIdentity, "integrity" | "integrityKind" | "byteLength"> & {
  packageJsonRaw?: Buffer;
  manifestFormatPath: string;
};

const CLAW_MARKDOWN_FILENAME = "CLAW.md";
const MAX_CLAW_PACKAGE_JSON_BYTES = 256 * 1024;

function fileDiagnostic(code: string, message: string, path = "$"): ClawDiagnostic {
  return { level: "error", code, phase: "parse", path, message };
}

function fileFailure(code: string, message: string, path = "$") {
  return { ok: false as const, diagnostics: [fileDiagnostic(code, message, path)] };
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function workspaceSourceDiagnostic(error: unknown, sourcePath: string): ClawDiagnostic {
  const { code, message } = clawWorkspaceSourceFailure(error, sourcePath, "source");
  return fileDiagnostic(code, message, "$.workspace");
}

function parsePackageJson(value: unknown): PackageJson | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value;
  const openclaw = record.openclaw;
  if (!isRecord(openclaw)) {
    return undefined;
  }
  const { claw } = openclaw;
  if (
    typeof record.name !== "string" ||
    !isCanonicalClawHubPackageName(record.name) ||
    typeof record.version !== "string" ||
    !isExactSemVer(record.version) ||
    typeof claw !== "string" ||
    claw.trim() === ""
  ) {
    return undefined;
  }
  return { name: record.name, version: record.version, openclaw: { claw } };
}

export function parseClawMarkdown(
  raw: Buffer,
  path: string,
): { ok: true; value: unknown; body: Buffer } | { ok: false; diagnostics: ClawDiagnostic[] } {
  const markdown =
    raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      ? raw.subarray(3)
      : raw;
  const byteText = markdown.toString("latin1");
  const match = byteText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return fileFailure(
      "missing_claw_frontmatter",
      `${path} must start with a YAML frontmatter block delimited by --- lines.`,
    );
  }
  const frontmatterBytes = Buffer.from(match[1] ?? "", "latin1");
  const body = markdown.subarray(match[0].length);
  let frontmatter: string;
  try {
    frontmatter = new TextDecoder("utf-8", { fatal: true }).decode(frontmatterBytes);
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return fileFailure("invalid_claw_markdown_utf8", `${path} must contain valid UTF-8.`);
  }
  const parsed = parseClawYaml(frontmatter, path, "frontmatter");
  return parsed.ok ? { ...parsed, body } : parsed;
}

function parseClawManifestDocument(
  raw: Buffer,
  path: string,
): { ok: true; value: unknown; body?: Buffer } | { ok: false; diagnostics: ClawDiagnostic[] } {
  if (basename(path).toLowerCase() === CLAW_MARKDOWN_FILENAME.toLowerCase()) {
    return parseClawMarkdown(raw, path);
  }
  try {
    return { ok: true, value: JSON.parse(decodeUtf8Input(raw, path)) };
  } catch (error) {
    return fileFailure("invalid_json", `Could not parse ${path}: ${(error as Error).message}`);
  }
}

async function readClawDocument(
  path: string,
  code: string,
  maxBytes: number,
  manifestFormatPath = path,
): Promise<
  | { ok: true; raw: Buffer; value: unknown; body?: Buffer }
  | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  let raw: Buffer;
  try {
    const fileRoot = await fsSafeRoot(dirname(path));
    const read = await fileRoot.read(basename(path), {
      hardlinks: "reject",
      maxBytes,
      symlinks: "reject",
    });
    raw = read.buffer;
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (error instanceof FsSafeError && error.code === "too-large");
    return fileFailure(
      tooLarge ? `${code}_too_large` : code,
      tooLarge
        ? `${path} exceeds ${maxBytes} bytes.`
        : `Could not read ${path}: ${(error as Error).message}`,
    );
  }
  const parsed = parseClawManifestDocument(raw, manifestFormatPath);
  return parsed.ok ? { ...parsed, raw } : parsed;
}

async function resolvePackageSource(
  packageRoot: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const packageRootReal = await realpath(packageRoot).catch(() => undefined);
  if (!packageRootReal) {
    return fileFailure("package_read_failed", `Could not resolve ${packageRoot}.`);
  }
  const packageJsonPath = resolve(packageRootReal, "package.json");
  const packageJsonResult = await readClawDocument(
    packageJsonPath,
    "package_read_failed",
    MAX_CLAW_PACKAGE_JSON_BYTES,
  );
  if (!packageJsonResult.ok) {
    return packageJsonResult;
  }
  const packageJson = parsePackageJson(packageJsonResult.value);
  if (!packageJson) {
    return fileFailure(
      "invalid_package_metadata",
      "package.json must declare non-empty name, version, and openclaw.claw fields.",
    );
  }
  if (isAbsolute(packageJson.openclaw.claw)) {
    return fileFailure("manifest_escapes_package", "openclaw.claw must be package-relative.");
  }
  const declaredManifestPath = resolve(packageRootReal, packageJson.openclaw.claw);
  const manifestPath = await realpath(declaredManifestPath).catch(() => undefined);
  if (!manifestPath || !isContained(packageRootReal, manifestPath)) {
    return fileFailure(
      "manifest_escapes_package",
      "The declared Claw manifest must resolve inside its package root.",
    );
  }
  return {
    ok: true,
    source: {
      kind: "package",
      name: packageJson.name,
      version: packageJson.version,
      packageRoot: packageRootReal,
      manifestPath,
      packageJsonRaw: packageJsonResult.raw,
      manifestFormatPath: declaredManifestPath,
    },
  };
}

async function resolveSource(
  path: string,
): Promise<
  { ok: true; source: ResolvedClawSource } | { ok: false; diagnostics: ClawDiagnostic[] }
> {
  const inputPath = resolve(path);
  const inputStat = await stat(inputPath).catch(() => undefined);
  if (!inputStat) {
    return fileFailure("read_failed", `Could not resolve Claw source ${inputPath}.`);
  }
  if (inputStat.isDirectory()) {
    const sourceRoot = await fsSafeRoot(inputPath);
    if (
      !(await sourceRoot.exists("package.json")) &&
      (await sourceRoot.exists(CLAW_MARKDOWN_FILENAME))
    ) {
      return resolveSource(resolve(inputPath, CLAW_MARKDOWN_FILENAME));
    }
    return resolvePackageSource(inputPath);
  }
  if (!inputStat.isFile()) {
    return fileFailure("unsupported_source", "Claw source must be a file or directory.");
  }

  const manifestPath = await realpath(inputPath);
  const packageRoot = await realpath(dirname(manifestPath));
  return {
    ok: true,
    source: {
      kind: "development",
      name: `local:${basename(manifestPath).replace(/\.json$/i, "")}`,
      version: "0.0.0-development",
      packageRoot,
      manifestPath,
      manifestFormatPath: inputPath,
    },
  };
}

export async function readClawManifestFile(
  path: string,
  options: {
    allowLegacyDynamicToolProfile?: boolean;
    authorizeLegacyLocalUpdateHostSettings?: (params: {
      manifest: ClawManifest;
      source: Pick<
        ClawSourceIdentity,
        "kind" | "name" | "version" | "packageRoot" | "manifestPath"
      >;
    }) => boolean | Promise<boolean>;
  } = {},
): Promise<ClawReadResult> {
  const sourceResult = await resolveSource(path);
  if (!sourceResult.ok) {
    return sourceResult;
  }
  const manifestResult = await readClawDocument(
    sourceResult.source.manifestPath,
    "read_failed",
    MAX_CLAW_MANIFEST_BYTES,
    sourceResult.source.manifestFormatPath,
  );
  if (!manifestResult.ok) {
    return manifestResult;
  }
  const parsed = parseClawManifest(manifestResult.value);
  if (!parsed.ok) {
    return parsed;
  }
  const hasMarkdownBody =
    manifestResult.body !== undefined && manifestResult.body.toString("utf8").trim().length > 0;
  if (hasMarkdownBody && clawManifestWorkspaceConflictsWithPath(parsed.manifest, "SOUL.md")) {
    return fileFailure(
      "claw_body_soul_conflict",
      "CLAW.md body content and an explicit SOUL.md workspace declaration cannot both be present.",
      "$.workspace",
    );
  }
  const legacyAuthorizationContext = {
    manifest: parsed.manifest,
    source: {
      kind: sourceResult.source.kind,
      name: sourceResult.source.name,
      version: sourceResult.source.version,
      packageRoot: sourceResult.source.packageRoot,
      manifestPath: sourceResult.source.manifestPath,
    },
  };
  const allowLegacyDynamicToolProfile = options.allowLegacyDynamicToolProfile === true;
  const allowLegacyLocalUpdateHostSettings = options.authorizeLegacyLocalUpdateHostSettings
    ? await options.authorizeLegacyLocalUpdateHostSettings(legacyAuthorizationContext)
    : false;
  const profile = await readClawOpenClawProfile({
    packageRoot: sourceResult.source.packageRoot,
    metadata: parsed.manifest.metadata,
    ...(allowLegacyDynamicToolProfile ? { allowLegacyDynamicToolProfile: true } : {}),
    ...(allowLegacyLocalUpdateHostSettings ? { allowLegacyLocalUpdateHostSettings: true } : {}),
  });
  if (!profile.ok) {
    return profile;
  }
  const resolvedSource = sourceResult.source;
  const hash = createHash("sha256");
  let byteLength = 0;
  const add = (label: string, bytes: Buffer) => {
    hash.update(`${Buffer.byteLength(label, "utf8")}:${label}:${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
    byteLength += bytes.byteLength;
  };
  const snapshotFile = (bytes: Buffer) => ({
    byteLength: bytes.byteLength,
    digest: digestClawBytes(bytes),
  });
  const manifestSnapshot = snapshotFile(manifestResult.raw);
  const profileSnapshot =
    profile.raw && profile.path
      ? {
          sourcePath: profile.path.replaceAll("\\", "/"),
          ...snapshotFile(profile.raw),
        }
      : undefined;
  add("canonical-source", Buffer.from(resolvedSource.manifestPath, "utf8"));
  add("manifest", manifestResult.raw);
  if (profile.raw && profile.path) {
    add(`profile:${profile.path.replaceAll("\\", "/")}`, profile.raw);
  }

  if (resolvedSource.kind === "package") {
    const packageJson = resolvedSource.packageJsonRaw;
    if (!packageJson) {
      return fileFailure("package_read_failed", "Could not snapshot package.json.");
    }
    add("package.json", packageJson);
  }

  const sourceRoot = await fsSafeRoot(resolvedSource.packageRoot);
  let packageBootstrap: ClawWorkspaceSourceSnapshot | undefined;
  if (await sourceRoot.exists("BOOTSTRAP.md")) {
    try {
      const read = await sourceRoot.read("BOOTSTRAP.md", {
        hardlinks: "reject",
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        symlinks: "reject",
      });
      const text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      if (text.trim().length === 0) {
        return fileFailure(
          "package_bootstrap_empty",
          "Package-root BOOTSTRAP.md must contain first-run instructions.",
          "$.bootstrap",
        );
      }
      const digest = digestClawBytes(read.buffer);
      add("bootstrap:BOOTSTRAP.md", read.buffer);
      packageBootstrap = {
        sourcePath: "BOOTSTRAP.md",
        realPath: read.realPath,
        byteLength: read.buffer.byteLength,
        digest,
      };
    } catch (error) {
      const tooLarge = error instanceof FsSafeError && error.code === "too-large";
      return fileFailure(
        tooLarge ? "package_bootstrap_too_large" : "package_bootstrap_invalid",
        tooLarge
          ? `Package-root BOOTSTRAP.md exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes.`
          : `Package-root BOOTSTRAP.md must be a safe UTF-8 regular file: ${(error as Error).message}`,
        "$.bootstrap",
      );
    }
  }

  const declaredSources = [
    ...Object.values(parsed.manifest.workspace.bootstrapFiles)
      .filter((entry): entry is { source: string } => entry !== undefined)
      .map((entry) => entry.source),
    ...parsed.manifest.workspace.files.map((entry) => entry.source),
  ].toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const openedSources: Array<{ sourcePath: string; opened: OpenResult }> = [];
  const workspaceSources: ClawWorkspaceSourceSnapshot[] = [];
  try {
    let workspaceByteLength = 0;
    for (const sourcePath of declaredSources) {
      try {
        await assertNoSymlinkParents({
          rootDir: resolvedSource.packageRoot,
          targetPath: resolve(resolvedSource.packageRoot, sourcePath),
          allowMissing: false,
          messagePrefix: "Workspace source",
        });
        const opened = await sourceRoot.open(sourcePath, {
          hardlinks: "reject",
          symlinks: "reject",
        });
        if (opened.stat.size > MAX_MANAGED_FILE_BYTES) {
          await opened[Symbol.asyncDispose]();
          throw new FsSafeError(
            "too-large",
            `file exceeds limit of ${MAX_MANAGED_FILE_BYTES} bytes (got ${opened.stat.size})`,
          );
        }
        workspaceByteLength += opened.stat.size;
        openedSources.push({ sourcePath, opened });
      } catch (error) {
        return { ok: false, diagnostics: [workspaceSourceDiagnostic(error, sourcePath)] };
      }
    }

    if (workspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
      return fileFailure(
        "workspace_sources_too_large",
        `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
        "$.workspace",
      );
    }

    let readWorkspaceByteLength = 0;
    for (const { sourcePath, opened } of openedSources) {
      let bytes: Buffer;
      try {
        bytes = await readFileHandleBounded(opened.handle, MAX_MANAGED_FILE_BYTES);
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "too-large") {
          return { ok: false, diagnostics: [workspaceSourceDiagnostic(error, sourcePath)] };
        }
        throw error;
      }
      readWorkspaceByteLength += bytes.byteLength;
      if (readWorkspaceByteLength > MAX_MANAGED_WORKSPACE_BYTES) {
        return fileFailure(
          "workspace_sources_too_large",
          `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`,
          "$.workspace",
        );
      }
      const digest = digestClawBytes(bytes);
      add(`workspace:${sourcePath}`, bytes);
      workspaceSources.push({
        sourcePath,
        realPath: opened.realPath,
        byteLength: bytes.byteLength,
        digest,
      });
    }
  } finally {
    await Promise.all(openedSources.map(({ opened }) => opened[Symbol.asyncDispose]()));
  }
  const source: ClawSourceIdentity = {
    kind: resolvedSource.kind,
    name: resolvedSource.name,
    version: resolvedSource.version,
    packageRoot: resolvedSource.packageRoot,
    manifestPath: resolvedSource.manifestPath,
    integrityKind: "development-snapshot",
    integrity: `sha256:${hash.digest("hex")}`,
    byteLength,
  };
  return {
    ok: true,
    manifest: parsed.manifest,
    ...(hasMarkdownBody ? { clawMarkdownBody: manifestResult.body } : {}),
    ...(packageBootstrap ? { packageBootstrap } : {}),
    ...(profile.profile ? { openClawProfile: profile.profile } : {}),
    source,
    snapshot: {
      manifest: manifestSnapshot,
      ...(profileSnapshot ? { openClawProfile: profileSnapshot } : {}),
      workspaceSources,
      ...(packageBootstrap ? { packageBootstrap } : {}),
    },
    diagnostics: [...parsed.diagnostics, ...(profile.diagnostics ?? [])],
  };
}
