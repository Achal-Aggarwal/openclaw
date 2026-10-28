import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import {
  original,
  preparation,
  stateV21Schema,
} from "../state/openclaw-historical-imports.test-support.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { productModelConfig } from "./server.chat-product.test-support.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type History = {
  messages: Array<{ role?: string; content?: unknown }>;
  pendingInputs: { items: Array<{ state: string }> };
};

it(
  "admits historical stores across cold Gateway restart without replay, and restores actual Doctor backups",
  { timeout: 360_000 },
  async (test) => {
    await runQaGatewayTestFixture(test, async ({ signal, verifyCleanup }) => {
      const requests: string[] = [];
      const providerErrors: unknown[] = [];
      const server = createServer((request, response) => {
        void readRequestText(request)
          .then((body) => {
            requests.push(body);
            writeOpenAiResponsesText(response, {
              text: "P3_USABLE_REPLY",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          })
          .catch((error: unknown) => {
            providerErrors.push(error);
            response.writeHead(500).end();
          });
      });
      const baseUrl = await listenProvider(server);
      const profile = "historical-import-" + randomUUID();
      const gateway = await createOpenClawTestInstance({
        name: "historical-import",
        signal,
        verifyCleanup,
        startTimeoutMs: 120_000,
        stopTimeoutMs: 10_000,
        gatewayArgs: ["--profile", profile],
        env: {
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
          no_proxy: [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost"]
            .filter(Boolean)
            .join(","),
          VITEST: undefined,
          NODE_ENV: "production",
          OPENCLAW_PROFILE: profile,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
      });
      gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      const statePath = gateway.state.statePath("state", "openclaw.sqlite");
      const agentPath = gateway.state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const message = "DO_NOT_REPLAY_HISTORICAL_INPUT";
      const archive =
        ' {"kind":"historical-recovery", "message":"DO_NOT_REPLAY_HISTORICAL_INPUT"} ';
      const now = Date.now();
      const originalInputId = randomUUID();
      try {
        const provider = buildMockOpenAiResponsesProvider(baseUrl, "historical-import-proof");
        const model = productModelConfig(gateway.state.workspaceDir, provider);
        await gateway.state.writeConfig({
          gateway: {
            mode: "local",
            port: gateway.port,
            auth: { mode: "token", token: gateway.gatewayToken },
            controlUi: { enabled: false },
          },
          logging: { level: "warn", file: gateway.state.path("gateway.log") },
          agents: {
            ownership: "explicit",
            defaults: { ...model.defaults, utilityModel: "", skills: [] },
            entries: { main: {} },
          },
          models: { ...model.models, catalogRefresh: { enabled: false } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        });
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        {
          using db = new DatabaseSync(statePath);
          db.exec(stateV21Schema());
          db.exec(
            "PRAGMA user_version=21; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',21,1,1);",
          );
          db.prepare(
            "INSERT INTO worker_environments (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,lease_id,preparation_key,preparation_purpose,preparation_demand_at_ms,preparation_expires_at_ms,preparation_consumed_at_ms,state,owner_epoch,attached_session_ids_json,created_at_ms,updated_at_ms,state_changed_at_ms,destroy_requested_at_ms) VALUES ('historical-image','synthetic','sandbox',?,'provision-image','lease-image',?,'reserve',?,?,?,'destroyed',7,'[]',?,?,?,?)",
          ).run(
            original,
            preparation.key,
            now - 10_000,
            now + 600_000,
            now - 5_000,
            now - 20_000,
            now - 3_000,
            now - 3_000,
            now - 3_000,
          );
          db.prepare(
            "INSERT INTO worker_session_placements (session_id,agent_id,session_key,execution_mode,state,environment_id,transition_generation,active_owner_epoch,repository_preparation,remote_workspace_dir,worker_bundle_hash,created_at_ms,updated_at_ms,state_changed_at_ms) VALUES ('sid-1','main','agent:main:history','worker-turn','active','historical-image',7,3,'pending','/repo','bundle',?,?,?)",
          ).run(now - 20_000, now - 3_000, now - 3_000);
        }
        fs.mkdirSync(path.dirname(agentPath), { recursive: true });
        {
          using db = new DatabaseSync(agentPath);
          db.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
          db.exec(
            "ALTER TABLE session_pending_inputs ADD COLUMN recovery_intent_json TEXT; PRAGMA user_version=24; INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES ('primary','agent',24,'main',1,1);",
          );
          db.prepare(
            "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES ('agent:main:history','sid-1',?,?)",
          ).run(JSON.stringify({ sessionId: "sid-1", updatedAt: now - 2_000 }), now - 2_000);
          db.prepare(
            "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES ('sid-1','agent:main:history',?,?)",
          ).run(now - 2_000, now - 2_000);
          db.prepare(
            "INSERT INTO session_pending_inputs(input_id,session_key,session_id,idempotency_key,run_id,request_hash,message_json,lifecycle_generation,state,accepted_at,recovery_intent_json) VALUES (?,'agent:main:history','sid-1',?,?,'historical-hash',?,'historical-generation','queued',?,?)",
          ).run(
            originalInputId,
            originalInputId,
            originalInputId,
            JSON.stringify({ role: "user", content: message, timestamp: now - 1_000 }),
            now - 1_000,
            archive,
          );
        }
        const doctor = () =>
          gateway.cli(["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"], {
            timeoutMs: 120_000,
          });
        const result = await doctor();
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const backups = [statePath, agentPath].map((pathname, index) => {
          const names = fs
            .readdirSync(path.dirname(pathname))
            .filter(
              (name) =>
                name.startsWith(path.basename(pathname) + ".pre-startup-migration-") &&
                name.endsWith(".bak") &&
                !name.endsWith(".scoped.bak"),
            );
          const selected = names.find((name) => {
            using db = new DatabaseSync(path.join(path.dirname(pathname), name), {
              readOnly: true,
            });
            return (
              db.prepare("PRAGMA user_version").get()?.user_version === (index === 0 ? 21 : 24)
            );
          });
          expect(selected).toBeDefined();
          return path.join(path.dirname(pathname), selected!);
        });
        const expectImported = () => {
          using agent = new DatabaseSync(agentPath, { readOnly: true });
          expect(
            agent
              .prepare(
                "SELECT state,recovery_intent_json FROM session_pending_inputs WHERE input_id=?",
              )
              .get(originalInputId),
          ).toEqual({ state: "interrupted", recovery_intent_json: archive });
          using shared = new DatabaseSync(statePath, { readOnly: true });
          expect(
            JSON.parse(
              String(
                shared
                  .prepare(
                    "SELECT profile_snapshot_json FROM worker_environments WHERE environment_id='historical-image'",
                  )
                  .get()?.profile_snapshot_json,
              ),
            ).historicalProfileSnapshotJson,
          ).toBe(original);
        };
        expectImported();
        const inode = fs.statSync(statePath).ino;
        const deviceIdentity = generateStoredDeviceIdentity();
        const pids: number[] = [];
        const key = "agent:main:dashboard:historical-proof";
        for (let start = 0; start < 2; start++) {
          await gateway.startGateway();
          expect(gateway.child?.pid).toBeTypeOf("number");
          pids.push(gateway.child!.pid!);
          client = await acquireGatewayTestClient(
            {
              deviceIdentity,
              env: gateway.state.env,
              url: gateway.url,
              token: gateway.gatewayToken,
              clientName: "test",
              mode: "test",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              hostDeps: {
                loadDeviceAuthToken: () => null,
                storeDeviceAuthToken: () => {},
                clearDeviceAuthToken: () => {},
              },
            },
            {
              signal,
              timeoutMs: 15_000,
              timeoutMessage: "historical proof connect timeout",
              closeMessage: "historical proof connection closed",
            },
          );
          const environments = await client.request<{
            environments: Array<{
              id: string;
              worker?: { state: string };
              preparation?: { key: string };
            }>;
          }>("environments.list", { includePreparedDetails: true }, { signal });
          expect(environments.environments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "historical-image",
                worker: expect.objectContaining({ state: "destroyed" }),
                preparation: expect.objectContaining({ key: preparation.key }),
              }),
            ]),
          );
          const imported = await client.request<History>(
            "chat.history",
            { sessionKey: "agent:main:history" },
            { signal },
          );
          expect(imported.pendingInputs.items.map((input) => input.state)).toEqual(["interrupted"]);
          expect(imported.messages).toEqual([]);
          if (start === 0) {
            await client.request("sessions.create", { key, agentId: "main" }, { signal });
          }
          const accepted = await client.request<{ runId: string }>(
            "chat.send",
            { sessionKey: key, message: "P3_CURRENT_" + start, idempotencyKey: randomUUID() },
            { signal },
          );
          const completed = await client.request<{ status: string }>(
            "agent.wait",
            { runId: accepted.runId, timeoutMs: 30_000 },
            { signal, timeoutMs: 35_000 },
          );
          expect(completed.status).toBe("ok");
          const history = await client.request<History>(
            "chat.history",
            { sessionKey: key },
            { signal },
          );
          expect(
            history.messages.filter(
              (entry) =>
                entry.role === "assistant" &&
                JSON.stringify(entry.content).includes("P3_USABLE_REPLY"),
            ),
          ).toHaveLength(start + 1);
          expect(requests.some((body) => body.includes(message))).toBe(false);
          await client.stopAndWait({ timeoutMs: 1_000 });
          client = undefined;
          await gateway.stopGateway();
          expect(fs.statSync(statePath).ino).toBe(inode);
          expectImported();
        }
        expect(pids[0]).not.toBe(pids[1]);
        expect(providerErrors).toEqual([]);
        // Full Doctor backups are consolidated files. Restore only after joining both owned Gateways.
        for (const [index, pathname] of [statePath, agentPath].entries()) {
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            fs.rmSync(pathname + suffix, { force: true });
          }
          fs.copyFileSync(backups[index]!, pathname);
        }
        {
          using shared = new DatabaseSync(statePath, { readOnly: true });
          using agent = new DatabaseSync(agentPath, { readOnly: true });
          expect(shared.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
          expect(agent.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
          expect(
            agent.prepare("SELECT state,recovery_intent_json FROM session_pending_inputs").get(),
          ).toEqual({ state: "queued", recovery_intent_json: archive });
        }
        const restored = await doctor();
        expect(restored.code, restored.stdout + restored.stderr).toBe(0);
        expectImported();
        console.info(
          "historical-import runtime proof",
          JSON.stringify({
            pids,
            sameMigratedDatabase: true,
            completedTurns: 2,
            historicalProviderRequests: 0,
            backupRestore: true,
          }),
        );
      } catch (error) {
        throw new Error(
          String(error) +
            "\n" +
            JSON.stringify({
              providerRequests: requests.length,
              providerErrors: providerErrors.map(String),
            }) +
            "\n" +
            (await gateway.diagnose()),
          { cause: error },
        );
      } finally {
        await runQaGatewayFixture(
          async () => {},
          () => client?.stopAndWait({ timeoutMs: 1_000 }),
          () => gateway.cleanup(),
          () => closeProvider(server),
        );
      }
    });
  },
);
