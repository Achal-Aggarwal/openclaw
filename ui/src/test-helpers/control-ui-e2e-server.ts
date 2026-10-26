// Own source-server acquisition and the shared identity/address contract for UI fixtures.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PreviewServer, ViteDevServer } from "vite";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { resolveAvailableLoopbackPort } from "./control-ui-e2e-port.ts";
import { extendControlUiE2eWaitTimeoutForSourceServer } from "./control-ui-e2e-readiness.ts";
import {
  getSharedControlUiE2ePreview,
  getSharedControlUiE2eSourceBaseUrl,
} from "./control-ui-e2e-shared-preview.ts";

const json5EsmPath = createRequire(import.meta.url).resolve("json5/dist/index.mjs");

export type ControlUiE2eServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ControlUiE2eServerOptions = {
  source?: boolean;
};

export const DEFAULT_CONTROL_UI_E2E_BUILD_INFO: ControlUiBuildInfo = {
  version: "2026.7.10",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-07-10T11:22:33.000Z",
  builtAt: "2026-07-10T12:34:56.000Z",
  branch: null,
  dirty: false,
  release: false,
  buildId: "e2e",
};

export function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export function resolveServerBaseUrl(server: ViteDevServer | PreviewServer): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI E2E server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}/`;
}

export async function startControlUiE2eServer(
  buildInfo?: ControlUiBuildInfo,
  options: ControlUiE2eServerOptions = {},
): Promise<ControlUiE2eServer> {
  // Ordinary E2E files exercise the shipped bundle. Default source tests borrow
  // the invocation's compiler; custom build identities still own a private server.
  const sharedPreview = getSharedControlUiE2ePreview();
  if (sharedPreview && buildInfo === undefined && options.source !== true) {
    return {
      baseUrl: sharedPreview.baseUrl,
      close: async () => {},
    };
  }
  extendControlUiE2eWaitTimeoutForSourceServer();
  const sharedSourceBaseUrl = getSharedControlUiE2eSourceBaseUrl();
  if (sharedSourceBaseUrl && buildInfo === undefined && options.source === true) {
    return { baseUrl: sharedSourceBaseUrl, close: async () => {} };
  }
  const resolvedBuildInfo = normalizeControlUiBuildInfo(
    buildInfo ?? DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
  );
  // Shared browser fixtures import this helper; load filesystem-bound Vite
  // configuration only when its Node-owned development server actually starts.
  const [
    { createServer },
    { controlUiLocaleModulesPlugin },
    { controlUiSolidPlugin },
    { controlUiPluginDistributionsPlugin },
    {
      commonJsOptimizeDeps,
      controlUiRuntimeDefines,
      resolveExternalPackageAliasesForVite,
      resolveSourcePackageAliasesForVite,
      resolveTsconfigPathAliasesForVite,
    },
  ] = await Promise.all([
    import("vite"),
    import("../../config/control-ui-locales.ts"),
    import("../../config/control-ui-solid.ts"),
    import("../../config/control-ui-plugin-distributions.ts"),
    import("../../vite.config.ts"),
  ]);
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const port = await resolveAvailableLoopbackPort();
  const server = await createServer({
    base: "/",
    // The shared default server stays alive while serial custom identities run.
    // Keep their dependency optimizer writes out of its cache.
    cacheDir: path.join(
      repoRoot,
      ".artifacts",
      buildInfo === undefined ? "control-ui-e2e-vite" : "control-ui-e2e-vite-custom",
    ),
    clearScreen: false,
    configFile: false,
    define: controlUiRuntimeDefines("serve", resolvedBuildInfo),
    logLevel: "error",
    optimizeDeps: {
      include: ["ipaddr.js", "@solidjs/testing-library", ...commonJsOptimizeDeps],
    },
    publicDir: path.join(uiRoot, "public"),
    plugins: [
      controlUiSolidPlugin(),
      controlUiLocaleModulesPlugin(),
      controlUiPluginDistributionsPlugin(repoRoot, new Set()),
    ],
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    root: uiRoot,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  await server.listen(port);
  return {
    baseUrl: resolveServerBaseUrl(server),
    close: () => server.close(),
  };
}
