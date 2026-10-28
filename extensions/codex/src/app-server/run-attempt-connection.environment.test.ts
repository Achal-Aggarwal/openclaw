import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { shouldRequireCodexSandboxExecServerEnvironment } from "./dynamic-tool-build.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  testCodexAppServerBindingStore,
  registerCodexTestSessionIdentity,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
  it.each([
    { requestPath: undefined, gitOnly: false },
    { requestPath: "/request/bin", gitOnly: false },
    { requestPath: undefined, gitOnly: true },
  ])(
    "preserves native shell policy with request PATH $requestPath and gitOnly=$gitOnly",
    async ({ requestPath, gitOnly }) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: async (method: string) => {
          if (method === "config/read") {
            return {
              config: {
                shell_environment_policy: {
                  inherit: "none",
                  set: {
                    PATH: "/native/bin",
                    KEEP: "yes",
                    ...(gitOnly ? { GIT_CONFIG_PARAMETERS: "'user.name=Native'" } : {}),
                  },
                },
              },
              origins: {},
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/start") {
            return threadStartResult("thread-1");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      });
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.config = undefined;
      registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
      await startOrResumeThread({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "local-loopback",
        },
        ...(gitOnly
          ? {
              shellGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
            }
          : {
              shellEnvironment: { PATH: "/tools:/gateway/bin" },
              shellPathPrepend: ["/tools"],
              disableLoginShell: true,
            }),
        config:
          requestPath === undefined
            ? undefined
            : { "shell_environment_policy.set.PATH": requestPath },
      });
      expect(
        fixture.request.mock.calls.find(([method]) => method === "thread/start")?.[1],
      ).toMatchObject({
        config: {
          ...(!gitOnly ? { allow_login_shell: false } : {}),
          shell_environment_policy: {
            inherit: "none",
            set: {
              PATH: gitOnly
                ? "/native/bin"
                : ["/tools", requestPath ?? "/native/bin"].join(path.delimiter),
              KEEP: "yes",
              ...(gitOnly
                ? {
                    GIT_CONFIG_PARAMETERS:
                      "'user.name=Native' 'maintenance.auto=false' 'gc.auto=0'",
                  }
                : {}),
            },
          },
        },
      });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "config/read"),
      ).toHaveLength(1);
    },
  );

  it.each(["local", "unconfigured-local", "unix", "proxy", "remote-root", "sandbox"])(
    "places the prepared environment only on owned local execution: %s",
    async (placement) => {
      vi.stubEnv("GIT_CONFIG_PARAMETERS", "'user.name=Ambient'");
      const params = createParams(
        path.join(tempDir, `path-${placement}.jsonl`),
        path.join(tempDir, `path-${placement}`),
      );
      const localToolEnv = { PATH: ["/fixture/tools", "/fixture/system"].join(path.delimiter) };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        preparedEnvironment: () => ({
          credentialScrubEnv: {},
          localIdentityEnv: {},
          managedLocalIdentity: false,
          localGitConfigParameters: "'maintenance.auto=false' 'gc.auto=0'",
          ...(placement === "unconfigured-local"
            ? {}
            : { localToolEnv, localToolPathPrepend: ["/fixture/tools"] }),
        }),
      };
      if (placement === "sandbox") {
        params.sandbox = createSandboxContext({});
      }
      const connection = await prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: {
            appServer:
              placement === "unix"
                ? { transport: "unix", homeScope: "user", url: "unix:///fixture/native.sock" }
                : {
                    transport: "stdio",
                    ...(placement === "remote-root"
                      ? { remoteWorkspaceRoot: "/remote/workspace" }
                      : {}),
                    ...(placement === "proxy"
                      ? { args: ["app-server", "proxy", "--sock", "/fixture/native.sock"] }
                      : {}),
                  },
          },
        },
      });
      using _ = { [Symbol.dispose]: connection.releaseBindingAuthority };
      try {
        const expected = placement === "local" ? localToolEnv : undefined;
        expect(connection.shellEnvironment).toEqual(expected);
        expect(connection.shellPathPrepend).toEqual(expected ? ["/fixture/tools"] : undefined);
        const ownedLocal = placement === "local" || placement === "unconfigured-local";
        const parameters = "'maintenance.auto=false' 'gc.auto=0'";
        expect(connection.shellGitConfigParameters).toBe(ownedLocal ? parameters : undefined);
        expect(connection.appServer.start.env?.PATH).toBe(expected?.PATH);
        const expectedParameters = ownedLocal ? `'user.name=Ambient' ${parameters}` : undefined;
        expect(
          resolveCodexAppServerSpawnEnv(connection.appServer.start, {}).GIT_CONFIG_PARAMETERS,
        ).toBe(expectedParameters);
        expect(connection.disableLoginShell).toBe(false);
        const refreshed = await connection.resolveRuntimeOptionsForCurrentBinding({
          modelProvider: "openai",
          model: params.modelId,
        });
        expect(refreshed.start.env?.PATH).toBe(expected?.PATH);
        expect(resolveCodexAppServerSpawnEnv(refreshed.start, {}).GIT_CONFIG_PARAMETERS).toBe(
          expectedParameters,
        );
        if (expected) {
          expect(codexAppServerStartOptionsKey(refreshed.start)).not.toBe(
            codexAppServerStartOptionsKey({
              ...refreshed.start,
              env: { ...refreshed.start.env, PATH: "/fixture/old" },
            }),
          );
        }
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    },
  );
});

it("selects the enrolled worker client without forwarding Gateway auth or local environment", async () => {
  vi.stubEnv("OPENCLAW_WORKER_CODEX_CONFIG_VERSION", "a".repeat(64));
  const params = createParams(path.join(tempDir, "worker.jsonl"), path.join(tempDir, "workspace"));
  params.permissionMode = "full";
  const sandbox = {
    ...createSandboxContext({}),
    backendId: "node",
    placementExecutionMode: "remote-exec",
    placementNodeId: "worker-node",
    placementEnvironmentId: "worker-environment",
    placementSessionId: params.sessionId,
    placementOwnerEpoch: 1,
  };
  params.sandbox = sandbox;
  const runtime = createPluginRuntimeMock();
  const open = vi
    .spyOn(runtime.nodes, "openDuplex")
    .mockRejectedValue(new Error("fixture worker dispatch reached"));
  const connection = await prepareCodexAttemptConnection({
    params,
    options: {
      bindingStore: testCodexAppServerBindingStore,
      runtime,
      pluginConfig: { appServer: { workerHostedCloud: true } },
    },
  });
  try {
    expect(connection.workerHostedCloud).toBe(true);
    expect(connection.callerOwnedAttemptClient).toBe(true);
    expect(connection.startupPreparedAuth).toBeUndefined();
    expect(connection.appServer.connectionClass).toBe("remote");
    expect(connection.effectiveWorkspace).toBe(params.sandbox.containerWorkdir);
    await expect(connection.attemptClientFactory()).rejects.toThrow(
      "fixture worker dispatch reached",
    );
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "worker-node",
      params: { authorization: "session-full" },
    });
  } finally {
    connection.cancellation.dispose();
    connection.releaseModelExecution();
    connection.releaseBindingAuthority();
  }
});

it("keeps non-node remote placements confined when worker hosting is configured", async () => {
  const sandbox = {
    ...createSandboxContext({}),
    backendId: "ssh",
    placementExecutionMode: "remote-exec",
  };
  expect(
    shouldRequireCodexSandboxExecServerEnvironment({
      sandbox,
      nativeToolSurfaceEnabled: true,
      sandboxExecServerEnabled: true,
      pluginConfig: { appServer: { workerHostedCloud: true } },
    }),
  ).toBe(true);
  const params = createParams(
    path.join(tempDir, "ssh-worker.jsonl"),
    path.join(tempDir, "ssh-workspace"),
  );
  params.permissionMode = "full";
  params.sandbox = sandbox;
  await expect(
    prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        runtime: createPluginRuntimeMock(),
        pluginConfig: { appServer: { workerHostedCloud: true } },
      },
    }),
  ).rejects.toThrow("requires an enrolled node");
});
