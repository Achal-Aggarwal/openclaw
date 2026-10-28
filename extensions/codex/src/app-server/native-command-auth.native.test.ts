import { once } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { prepareAgentRuntimeAuth } from "openclaw/plugin-sdk/agent-harness-runtime";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { sendNativeResponse } from "./thread-native.test-support.js";

// Public test leaf signed by PROXY_FIXTURE_CERTIFICATE; native rustls rejects CA certificates as server leaves.
const SERVER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIBAjAKBggqhkjOPQQDAjAbMRkwFwYDVQQDDBBmaWxlcy5w
cm94eS50ZXN0MCAXDTI2MTAyODA1MzQ0N1oYDzIxMjYxMDA0MDUzNDQ3WjAUMRIw
EAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS2agSj
NN3IROHs3GAdJdxO0snmqgW2RetuJKeRbn/e082TR8Sx5/yPcAcyAp6hEH19g3tF
/CT7/QGiGm96BZheo2UwYzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAT
BgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREECDAGhwR/AAABMB0GA1UdDgQWBBRQ
mY8ZLuaAJjUU4JiehaVg+f+KoDAKBggqhkjOPQQDAgNIADBFAiEAv6I7QWvupklp
hanSnrw4JsVCI2kI/YCizAz6F1Lcr6kCIFCwSRa2gtugKpCQ9YeTPCVylRLd/K+p
IVAnJ8E0VJ6i
-----END CERTIFICATE-----`;

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

it("runs a custom HTTPS model through Codex command auth without borrowing host credentials", async () => {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [key, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
  vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-openai-key");
  vi.stubEnv("CODEX_API_KEY", "synthetic-ambient-codex-key");
  vi.stubEnv("CODEX_ACCESS_TOKEN", "synthetic-ambient-token");
  const ca = path.join(root, "fixture-ca.pem");
  await fs.writeFile(ca, PROXY_FIXTURE_CERTIFICATE);
  vi.stubEnv("SSL_CERT_FILE", ca);
  const command = path.join(root, "credential.mjs");
  await fs.writeFile(
    command,
    [
      "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) process.exit(21);",
      'process.stdout.write("synthetic-command-token");',
    ].join("\n"),
  );
  const requests: { authorization?: string; model: unknown }[] = [];
  const server = https.createServer(
    { key: PROXY_FIXTURE_KEY, cert: SERVER_CERTIFICATE },
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const parsed: unknown = JSON.parse(body);
        if (!isJsonObject(parsed)) {
          throw new Error("Invalid fixture request");
        }
        requests.push({ authorization: request.headers.authorization, model: parsed.model });
        sendNativeResponse(response, "command-auth-response", {
          type: "message",
          role: "assistant",
          id: "command-answer",
          content: [{ type: "output_text", text: "Command-auth response." }],
        });
      });
    },
  );
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing HTTPS fixture port");
  }
  const baseUrl = "https://127.0.0.1:" + address.port + "/v1";
  const provider = "command-fixture";
  const modelId = "gpt-5.6-luna";
  await fs.writeFile(
    path.join(native.codexHome, "config.toml"),
    [
      "model=" + JSON.stringify(modelId),
      "model_provider=" + JSON.stringify(provider),
      'cli_auth_credentials_store="ephemeral"',
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      "allow_login_shell=false",
      "[features]",
      "shell_snapshot=false",
      "[analytics]",
      "enabled=false",
      "[feedback]",
      "enabled=false",
      "[model_providers." + provider + "]",
      'name="Synthetic command provider"',
      "base_url=" + JSON.stringify(baseUrl),
      'wire_api="responses"',
      "requires_openai_auth=false",
      "supports_websockets=false",
      "request_max_retries=0",
      "stream_max_retries=0",
      "[model_providers." + provider + ".auth]",
      "command=" + JSON.stringify(process.execPath),
      "args=[" + JSON.stringify(command) + "]",
    ].join("\n"),
  );
  const params = createNativeRunParams(path.join(root, "session.jsonl"), native.cwd);
  params.provider = provider;
  params.modelId = modelId;
  params.model = { ...params.model, provider, id: modelId, api: "openai-responses", baseUrl };
  params.config = {
    models: {
      providers: {
        [provider]: {
          api: "openai-responses",
          auth: "native-command",
          baseUrl,
          agentRuntime: { id: "codex" },
          models: [
            {
              id: modelId,
              name: "Synthetic command model",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
        },
      },
    },
  };
  params.authProfileStore = {
    version: 1,
    profiles: {
      "openai:decoy": { type: "api_key", provider: "openai", key: "synthetic-stored-key" },
    },
  };
  const prepared = prepareAgentRuntimeAuth({
    provider,
    modelId,
    modelApi: params.model.api,
    modelBaseUrl: baseUrl,
    config: params.config,
    authProfileStore: params.authProfileStore,
    harnessId: "codex",
    harnessRuntime: "codex",
    harnessAuthBootstrap: "harness",
  });
  params.runtimePlan = { ...createCodexRuntimePlanFixture(), auth: prepared.plan };
  params.timeoutMs = 20000;
  let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
  const options: Parameters<typeof runCodexAppServerAttempt>[1] = {
    pluginConfig: {
      appServer: {
        command: native.command,
        args: ["app-server"],
        homeScope: "user",
        sandbox: "read-only",
        approvalPolicy: "never",
        clearEnv: Object.keys(process.env).filter(
          (key) =>
            !(key in native.env) &&
            !["SSL_CERT_FILE", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].includes(
              key,
            ),
        ),
      },
    },
    nativeHookRelay: { enabled: false },
    clientFactory: async (clientOptions) => {
      expect(clientOptions?.authProfileId).toBeNull();
      expect(clientOptions?.preparedAuth).toBeUndefined();
      client ??= await createIsolatedCodexAppServerClient(clientOptions);
      return client;
    },
  };
  try {
    const result = await runCodexAppServerAttempt(params, options);
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(requests).toEqual([{ authorization: "Bearer synthetic-command-token", model: modelId }]);
    expect(
      await fs.stat(path.join(native.codexHome, "auth.json")).catch(() => undefined),
    ).toBeUndefined();
    await expect(
      runCodexAppServerAttempt(
        {
          ...params,
          runId: "mismatched-route",
          model: { ...params.model, baseUrl: "https://other.example.test/v1" },
        },
        options,
      ),
    ).rejects.toThrow("matching Codex model_providers entry");
    expect(requests).toHaveLength(1);
  } finally {
    if (client) {
      expect(await client.closeAndWait()).toMatchObject({ exited: true });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}, 45000);
