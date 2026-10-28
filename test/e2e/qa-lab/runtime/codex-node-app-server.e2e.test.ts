// Keyless Linux full composition; run through the documented network-none runner.
// Inference itself must run on the paired node. Not live-model/cloud bootstrap proof.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  MARKERS,
  MODEL_ID,
  MODEL_REF,
  observeWorkerWire,
  stageWorkerCodex,
  startWorkerResponses,
  type Scenario,
} from "./codex-node-app-server.test-support.js";
import {
  approvePairing,
  createChildEnv,
  processIsAlive,
  readNode,
  startNodeProcess,
  stopChild,
  type CapturedChild,
  type GatewayHandle,
} from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SESSION_KEY = "agent:qa:codex-node-app-server-proof";
const TIMEOUT_MS = 120_000;
const WAIT = { timeout: 30_000, interval: 100 };
type Session = {
  execCwd?: string;
  spawnedCwd?: string;
  permissionMode?: string;
  agentRuntime?: { id: string };
  placement?: { state?: string; remoteWorkspaceDir?: string; workspaceBaseManifestRef?: string };
};
type AuthObservation = {
  nativePids: number[];
  appServerPid: number;
  nodePid: number;
  parentAppServer: boolean;
  home: string;
  codexHome: string;
};
type NativeEvidence = { pid: number; cwd: string; home: string; codexHome?: string };
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}
async function describeSession(gateway: GatewayHandle) {
  return ((await gateway.call("sessions.describe", { key: SESSION_KEY })) as { session: Session })
    .session;
}

// The ordinary first-party route supplies only a synthetic Gateway availability key.
// Actual inference must use the worker command bearer; no forced harness or client injection.
describe.skipIf(process.platform !== "linux")("Codex worker-hosted app-server composition", () => {
  it(
    "selects the exact admitted Full worker, resumes, cancels, and joins cleanup",
    { timeout: 360_000 },
    async ({ signal }) => {
      const root = await fs.realpath(tempDirs.make("openclaw-codex-worker-app-server-"));
      const nodeHome = path.join(root, "node-home");
      const nodeState = path.join(root, "node-state");
      const nodeTmp = path.join(root, "node-tmp");
      const nodeConfigPath = path.join(root, "node.json");
      await Promise.all(
        [nodeHome, nodeState, nodeTmp].map((dir) =>
          fs.mkdir(dir, { recursive: true, mode: 0o700 }),
        ),
      );
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let node: CapturedChild | undefined;
      let client: GatewayClient | undefined;
      let receipts: FixtureReceiptChannel | undefined;
      let provider: Awaited<ReturnType<typeof startWorkerResponses>> | undefined;
      let wire: Awaited<ReturnType<typeof observeWorkerWire>> | undefined;
      let published: PublishedWireWorkspace | undefined;
      let clientClosed = false;
      const settlement = createWireWorkspaceSettlementWaiter();

      await runQaGatewayFixture(
        async () => {
          receipts = await openFixtureReceiptChannel();
          provider = await startWorkerResponses(receipts.endpoint);
          const staged = await stageWorkerCodex({
            root,
            nodeState,
            providerBaseUrl: provider.baseUrl,
          });
          expect(staged.command).toMatch(/^codex\.app-server\.stdio\.v1\.[a-f0-9]{64}$/);
          for (const name of ["version", "config.toml", "token.mjs"]) {
            expect((await fs.stat(path.join(staged.workerHome, name))).mode & 0o777).toBe(0o600);
          }
          expect((await fs.stat(staged.workerHome)).mode & 0o777).toBe(0o700);
          published = await createPublishedWireWorkspace(path.join(root, "workspace"));
          gateway = await gatewayOwner.start({
            repoRoot: process.cwd(),
            initializeCurrentRuntimeState: true,
            command: {
              executablePath: process.execPath,
              argsPrefix: ["dist/index.js"],
              cwd: process.cwd(),
              // Managed workspace admission needs disk-backed scratch, not the runner’s /tmp tmpfs.
              tempParentDir: root,
              usePackagedPlugins: false,
            },
            transportBaseUrl: "http://127.0.0.1",
            providerMode: "mock-openai",
            providerBaseUrl: `${provider.baseUrl}/v1`,
            primaryModel: MODEL_REF,
            alternateModel: MODEL_REF,
            enabledPluginIds: ["codex", "openai"],
            mockAuthAgentIds: [],
            controlUiEnabled: false,
            runtimeEnvPatch: {
              // No ambient credentials: these are newly authored synthetic sources.
              OPENAI_API_KEY: "p8-gateway-synthetic-decoy",
              CODEX_HOME: staged.sourceHome,
              OPENCLAW_WORKER_CODEX_CONFIG_PATH: staged.sourceConfig,
              OPENCLAW_WORKER_CODEX_HELPER_PATH: staged.sourceHelper,
              OPENCLAW_WORKER_CODEX_CONFIG_VERSION: staged.version,
            },
            mutateConfig: (config) => {
              config.auth = {};
              config.models = { mode: "merge", providers: {} };
              const defaults = (config.agents!.defaults ??= {});
              defaults.models = { [MODEL_REF]: {} };
              defaults.mediaModels = undefined;
              config.agents!.entries!.qa!.tools = { profile: "full" };
              config.tools = {
                profile: "full",
                toolSearch: false,
                codeMode: false,
                exec: { mode: "full" },
              };
              config.memory = { search: { enabled: false } };
              config.plugins!.slots = { ...config.plugins!.slots, memory: "none" };
              config.plugins!.entries!["memory-core"] = { enabled: false };
              config.plugins!.entries!.codex = {
                enabled: true,
                config: {
                  appServer: { homeScope: "user", workerHostedCloud: true },
                  supervision: { enabled: false },
                },
              };
              config.gateway!.nodes = {
                commands: { allow: [staged.command] },
                pairing: { autoApproveLocal: false, sshVerify: false },
              };
              config.nodeHost = { workerRuns: { enabled: true } };
              return config;
            },
          });
          client = await acquireGatewayTestClient(
            {
              url: gateway.wsUrl,
              token: gateway.token,
              role: "operator",
              deviceIdentity: null,
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
              requestTimeoutMs: TIMEOUT_MS,
              onEvent: settlement.onEvent,
              onClose: () => {
                clientClosed = true;
              },
            },
            {
              timeoutMs: TIMEOUT_MS,
              timeoutMessage: "P8 operator connection timed out",
              closeMessage: "P8 operator closed",
              signal,
            },
          );
          wire = await observeWorkerWire(gateway.wsUrl, staged.command);
          const nodeConfig: OpenClawConfig = {
            gateway: { mode: "local" },
            plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
            nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
          };
          await fs.writeFile(nodeConfigPath, JSON.stringify(nodeConfig), { mode: 0o600 });
          const nodeEnv = createChildEnv({
            home: nodeHome,
            tempDir: nodeTmp,
            extra: {
              OPENCLAW_HOME: nodeHome,
              OPENCLAW_STATE_DIR: nodeState,
              OPENCLAW_CONFIG_PATH: nodeConfigPath,
              OPENCLAW_GATEWAY_TOKEN: gateway.token,
              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
              OPENCLAW_WORKER_CODEX_CONFIG_VERSION: staged.version,
            },
          });
          expect(nodeEnv).not.toHaveProperty("OPENAI_API_KEY");
          expect(nodeEnv).not.toHaveProperty("CODEX_HOME");
          expect(nodeEnv).not.toHaveProperty("GITHUB_TOKEN");
          node = startNodeProcess(wire.port, nodeEnv);
          const nodeId = await approvePairing(gateway, "device");
          await stopChild(node);
          node = startNodeProcess(wire.port, nodeEnv);
          await approvePairing(gateway, "node", nodeId);
          await stopChild(node);
          node = startNodeProcess(wire.port, nodeEnv);
          const nodePid = node.child.pid;
          expect(nodePid).toEqual(expect.any(Number));
          await vi.waitFor(async () => {
            expect(await readNode(gateway!, nodeId)).toMatchObject({
              paired: true,
              connected: true,
              approvalState: "approved",
              sessionHost: true,
              commands: expect.arrayContaining([staged.command]),
            });
            const inventory = await client!.request<{
              environments: Array<{
                id: string;
                status: string;
                sessionHost: boolean;
                invocableCommands: string[];
              }>;
            }>("environments.list", {});
            expect(
              inventory.environments.find((entry) => entry.id === `node:${nodeId}`),
            ).toMatchObject({
              status: "available",
              sessionHost: true,
              invocableCommands: expect.arrayContaining([staged.command]),
            });
          }, WAIT);

          const catalog = await client.request<{
            models: Array<{ provider: string; id: string; available?: boolean }>;
          }>("models.list", { agentId: "qa", refresh: true }, { timeoutMs: TIMEOUT_MS });
          expect(
            catalog.models.find((entry) => entry.provider === "openai" && entry.id === MODEL_ID),
            "The ordinary first-party catalog must admit the configured model without a forced harness.",
          ).toMatchObject({ available: true });
          await gateway.call("sessions.create", {
            key: SESSION_KEY,
            agentId: "qa",
            model: MODEL_REF,
            permissionMode: "full",
            worktree: true,
            worktreeName: "codex-worker-app-server-proof",
            worktreeBaseRef: "main",
            cwd: published.source,
          });
          const local = await describeSession(gateway);
          expect(local.permissionMode).toBe("full");
          const localWorkspace = local.execCwd ?? local.spawnedCwd;
          if (!localWorkspace) {
            throw new Error("P8 session omitted its managed workspace");
          }
          await gateway.call(
            "sessions.dispatch",
            { key: SESSION_KEY, deviceId: nodeId },
            { timeoutMs: TIMEOUT_MS },
          );
          const placed = await describeSession(gateway);
          expect(placed.placement?.state).toBe("active");
          const remoteWorkspace = placed.placement?.remoteWorkspaceDir;
          if (!remoteWorkspace) {
            throw new Error("P8 dispatch omitted its remote workspace");
          }
          expect(remoteWorkspace).not.toBe(localWorkspace);

          const observations = async () =>
            Promise.all(
              (await fs.readdir(staged.observations)).map((name) =>
                readJson<AuthObservation>(path.join(staged.observations, name)),
              ),
            );
          const expectNativeCleanup = async () => {
            // Foreign PIDs expose no fixture exit signal: observe eventual extinction
            // before stopping the node, so teardown cannot supply the missing cleanup.
            await vi.waitFor(async () => {
              const seen = await observations();
              expect(seen.length).toBeGreaterThan(0);
              for (const entry of seen) {
                expect(entry).toMatchObject({ nodePid, parentAppServer: true });
                expect(entry.home.startsWith(`${nodeState}${path.sep}`)).toBe(true);
                expect(
                  entry.codexHome.startsWith(
                    path.join(entry.home, ".openclaw-worker", "codex") + path.sep,
                  ),
                ).toBe(true);
                expect(entry.nativePids).toContain(entry.appServerPid);
                for (const pid of entry.nativePids) {
                  expect(processIsAlive(pid)).toBe(false);
                }
              }
            }, WAIT);
          };
          const start = async (scenario: Scenario) => {
            const runId = randomUUID();
            expect(
              await client!.request("chat.send", {
                sessionKey: SESSION_KEY,
                message: MARKERS[scenario],
                deliver: false,
                idempotencyKey: runId,
              }),
            ).toMatchObject({ runId, status: "started" });
            return runId;
          };
          const wait = (runId: string) =>
            client!.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: TIMEOUT_MS },
              { timeoutMs: TIMEOUT_MS + 5_000 },
            );
          const checkEvidence = async (scenario: Scenario, directory: string) => {
            const evidence = await readJson<NativeEvidence>(
              path.join(directory, `p8-${scenario}.json`),
            );
            expect(evidence).toMatchObject({
              cwd: remoteWorkspace,
              providerKeyPresent: false,
              forgeTokenPresent: false,
              gatewayTokenPresent: false,
              runtimeInjectionPresent: false,
            });
            expect(evidence.home).not.toBe(nodeHome);
            expect(evidence.home.startsWith(`${nodeState}${path.sep}`)).toBe(true);
            return evidence;
          };
          let threadId: string | undefined;
          for (const scenario of ["first", "second"] as const) {
            const before = wire.requests.length;
            const manifest = (await describeSession(gateway)).placement?.workspaceBaseManifestRef;
            const runId = await start(scenario);
            expect(await wait(runId), gateway.logs()).toMatchObject({ status: "ok" });
            await settlement.wait(client, SESSION_KEY, signal, manifest);
            await checkEvidence(scenario, localWorkspace);
            expect((await describeSession(gateway)).agentRuntime?.id).toBe("codex");
            const native = wire.requests.slice(before);
            const request = native.find(
              (entry) => entry.method === (scenario === "first" ? "thread/start" : "thread/resume"),
            );
            expect(request, "Real node duplex must carry thread start/resume").toBeDefined();
            if (!request) {
              throw new Error("Native thread request missing");
            }
            const reply = wire.responses.find(
              (entry) => entry.invokeId === request.invokeId && entry.id === request.id,
            );
            const thread = reply?.result?.thread;
            expect(thread).toMatchObject({ id: expect.any(String) });
            if (!isRecord(thread) || typeof thread.id !== "string") {
              throw new Error("Native thread response missing");
            }
            if (scenario === "first") {
              threadId = thread.id;
            } else {
              expect(request.params?.threadId).toBe(threadId);
              expect(thread.id).toBe(threadId);
            }
            expect(native.find((entry) => entry.method === "turn/start")?.params?.threadId).toBe(
              threadId,
            );
            const invoke = wire.invokes.find((entry) => entry.id === request.invokeId);
            expect(invoke).toMatchObject({
              command: staged.command,
              params: {
                authorization: "session-full",
                placement: { sessionKey: SESSION_KEY, cwd: remoteWorkspace },
              },
            });
            expect(
              provider.requests
                .filter((entry) => entry.scenario === scenario)
                .map((entry) => ({ auth: entry.workerAuth, completed: entry.completed })),
            ).toEqual([
              { auth: true, completed: false },
              { auth: true, completed: true },
            ]);
            await expectNativeCleanup();
          }
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: SESSION_KEY,
            limit: 50,
          });
          expect(JSON.stringify(history.messages)).toContain(`${MARKERS.first}_OK`);
          expect(JSON.stringify(history.messages)).toContain(`${MARKERS.second}_OK`);

          const cancelOffset = wire.requests.length;
          const cancelledRun = await start("cancel");
          const cancelledOutcome = wait(cancelledRun);
          await withinTest(
            Promise.race([
              receipts.waitFor(MARKERS.cancel, "started"),
              cancelledOutcome.then((outcome) => {
                throw new Error(
                  "Cancellation command never reached its held state: " + JSON.stringify(outcome),
                );
              }),
            ]),
            signal,
          );
          const held = await checkEvidence("cancel", remoteWorkspace);
          expect(processIsAlive(held.pid)).toBe(true);
          const heldTurn = wire.requests
            .slice(cancelOffset)
            .find((entry) => entry.method === "turn/start");
          expect(heldTurn?.params?.threadId).toBe(threadId);
          expect(
            await client.request("chat.abort", { sessionKey: SESSION_KEY, runId: cancelledRun }),
          ).toMatchObject({ aborted: true, runIds: expect.arrayContaining([cancelledRun]) });
          expect(await cancelledOutcome).toMatchObject({
            status: "error",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          });
          await withinTest(receipts.waitForExit(MARKERS.cancel), signal);
          await vi.waitFor(() => {
            expect(processIsAlive(held.pid)).toBe(false);
            expect(wire!.cancelled.has(heldTurn!.invokeId)).toBe(true);
          }, WAIT);
          await expectNativeCleanup();
          expect(
            provider.requests.every(
              (entry) =>
                entry.workerAuth &&
                entry.model === MODEL_ID &&
                entry.tools.includes("exec_command"),
            ),
          ).toBe(true);
          expect(provider.requests.filter((entry) => entry.scenario === "cancel")).toHaveLength(1);
          expect(
            wire.invokes
              .filter((entry) => entry.command.startsWith("codex."))
              .every((entry) => entry.command === staged.command),
          ).toBe(true);
          expect(wire.errors).toEqual([]);
          expect(provider.errors).toEqual([]);

          await stopChild(node);
          expect(processIsAlive(nodePid!)).toBe(false);
          await vi.waitFor(async () => {
            expect(await readNode(gateway!, nodeId)).toMatchObject({ connected: false });
            expect(wire!.connectionCount).toBe(0);
          }, WAIT);
          await client.stopAndWait({ timeoutMs: 5_000 });
          expect(clientClosed).toBe(true);
        },
        () => stopChild(node),
        () => client?.stopAndWait({ timeoutMs: 5_000 }),
        () => stopQaGatewayFixture(gatewayOwner),
        () => wire?.close(),
        () => (published ? closeWireServer(published.server) : undefined),
        () => provider?.close(),
        () => receipts?.close(),
      ).catch((cause: unknown) => {
        throw new Error(`P8 worker fixture failed:\n${node?.logs() ?? "Node was not started"}`, {
          cause,
        });
      });
    },
  );
});
