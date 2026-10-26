import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { writePlugin } from "../../plugins/loader.test-fixtures.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";

// Real direct compaction, plugin harness registry, AgentSession, and SQLite transcript; only the
// provider is a local OpenAI-compatible endpoint whose primary summary requests fail auth.
type SessionTarget = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Fixture = { state: OpenClawTestState; config: OpenClawConfig; target: SessionTarget };

let summaryRequests: string[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      summaryRequests.push(body);
      if (!body.includes('"model":"fallback-model"')) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "summary model authentication failed" } }));
        return;
      }
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "summary",
          object: "chat.completion.chunk",
          created: 1,
          model: "model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunk({ role: "assistant", content: "## Goal\nModel summary after recovery." }, null) +
          `${chunk({}, "stop")}data: [DONE]\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  summaryRequests = [];
});

const FILLER = "older context ".repeat(200);

/** Appends user -> assistant tool call -> tool result turns and returns their entry ids. */
function appendToolTurns(fixture: Fixture, first: number, count: number): string[] {
  const manager = SessionManager.open(fixture.target, fixture.state.workspaceDir);
  const ids: string[] = [];
  for (let turn = first; turn < first + count; turn += 1) {
    ids.push(
      manager.appendMessage({
        role: "user",
        content: `ask ${turn}: ${FILLER}`,
        timestamp: turn * 10 + 1,
      }),
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: {} }],
        api: "openai-completions",
        provider: "fixture",
        model: "model",
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: turn * 10 + 2,
      }),
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${turn}: ${FILLER}` }],
        isError: false,
        timestamp: turn * 10 + 3,
      }),
    );
  }
  return ids;
}

async function createFixture() {
  const state = await createOpenClawTestState({ prefix: "openclaw-summary-fallback-" });
  onTestFinished(async () => {
    await closePreparedModelRuntimeSnapshots();
    await state.cleanup();
  });
  const model = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1024,
  });
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "fixture/model" },
        compaction: { timeoutSeconds: 60, keepRecentTokens: 300 },
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "synthetic-fixture",
          baseUrl,
          models: [model("model"), model("fallback-model")],
        },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
  };
  await state.writeConfig(config);
  const target = {
    agentId: "main",
    sessionId: "summary-fallback",
    sessionKey: "agent:main:summary-fallback",
    storePath: state.path("sessions.sqlite"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const fixture = { state, config, target };
  return { ...fixture, seeded: appendToolTurns(fixture, 0, 8) };
}

function openSession(fixture: Fixture) {
  return SessionManager.open(fixture.target, fixture.state.workspaceDir);
}

function getCompactions(fixture: Fixture) {
  return openSession(fixture)
    .getBranch()
    .filter((entry) => entry.type === "compaction");
}

it.each([false, true])(
  "uses the fallback model's runtime only for unlocked native sessions (locked=%s)",
  async (locked) => {
    const fixture = await createFixture();
    const plugin = writePlugin({
      id: "summary-native",
      dir: fixture.state.path("summary-native"),
      registration: `api.registerAgentHarness({
      id: "summary-native",
      label: "Primary summary runtime",
      authBootstrap: "harness",
      supports: (context) => context.requestedRuntime === "summary-native" && context.provider === "fixture"
        ? { supported: true }
        : { supported: false, reason: "Primary runtime cannot run the fallback provider" },
      runAttempt: async () => { throw new Error("Compaction must not run an agent turn"); },
    });`,
    });
    await fs.writeFile(
      fixture.state.path("summary-native", "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        activation: { onStartup: false, onAgentHarnesses: ["summary-native"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    const primary = fixture.config.models!.providers!.fixture!;
    fixture.config.models!.providers!.backup = {
      ...primary,
      models: primary.models.filter(({ id }) => id === "fallback-model"),
    };
    delete primary.apiKey;
    fixture.config.agents!.defaults!.model = {
      primary: "fixture/model",
      fallbacks: ["backup/fallback-model"],
    };
    fixture.config.plugins = {
      allow: [plugin.id],
      load: { paths: [plugin.dir] },
      slots: { memory: "none" },
    };
    await fixture.state.writeConfig(fixture.config);
    loadAndActivateRootPluginRegistry({
      config: fixture.config,
      workspaceDir: fixture.state.workspaceDir,
      onlyPluginIds: [plugin.id],
      cache: false,
    });
    const scope = new AsyncWorkScope();
    let result;
    try {
      result = await scope.run(() =>
        compactEmbeddedAgentSessionDirect({
          ...fixture.target,
          sessionTarget: fixture.target,
          sessionFile: fixture.target.sessionKey,
          workspaceDir: fixture.state.workspaceDir,
          agentDir: fixture.state.agentDir(),
          config: fixture.config,
          provider: "fixture",
          model: "model",
          agentHarnessId: "summary-native",
          modelSelectionLocked: locked,
          trigger: "budget",
          force: true,
        }),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
    }

    expect(JSON.parse(summaryRequests[0]!).model).toBe("model");
    if (locked) {
      expect(result).toMatchObject({ ok: false, compacted: false });
      expect(summaryRequests.map((request) => JSON.parse(request).model)).not.toContain(
        "fallback-model",
      );
      expect(getCompactions(fixture)).toHaveLength(0);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
    expect(summaryRequests.map((request) => JSON.parse(request).model)).toContain("fallback-model");
    expect(getCompactions(fixture).at(-1)?.summary).toContain("Model summary after recovery.");
    const session = openSession(fixture);
    expect(
      session
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual(fixture.seeded);
    expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-7",
    });
  },
);
