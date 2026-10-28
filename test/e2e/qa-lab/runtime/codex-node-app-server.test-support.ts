import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, request as forwardHttp, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { listMockCodexModelInfos } from "../../../../extensions/qa-lab/api.js";
import { createNodeDuplexEndpoint } from "../../../../src/infra/node-duplex-framing.js";
import { fixtureReceiptClientSource } from "../../../helpers/fixture-receipts.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { closeWireServer } from "./paired-node-worker-wire-fixture.js";

export const MODEL_ID = "gpt-5.6-luna";
export const MODEL_REF = `openai/${MODEL_ID}`;
export const MARKERS = {
  first: "P8_WORKER_FIRST",
  second: "P8_WORKER_SECOND",
  cancel: "P8_WORKER_CANCEL",
} as const;
export type Scenario = keyof typeof MARKERS;
const WORKER_BEARER = "p8-worker-synthetic-bearer";

function respond(response: ServerResponse, item: Record<string, unknown>) {
  const id = `resp_p8_${randomUUID()}`;
  writeOpenAiResponsesSse(response, [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
      },
    },
  ]);
}

function scenarioFor(body: Record<string, unknown>): Scenario | undefined {
  for (const item of (Array.isArray(body.input) ? body.input : []).toReversed()) {
    if (isRecord(item) && item.role === "user") {
      const text = JSON.stringify(item);
      const scenario = (Object.keys(MARKERS) as Scenario[]).find((key) =>
        text.includes(MARKERS[key]),
      );
      if (scenario) {
        return scenario;
      }
    }
  }
  return undefined;
}

function nativeCommand(scenario: Scenario, receiptEndpoint: string): string {
  const source = [
    'import fs from "node:fs";',
    fixtureReceiptClientSource(receiptEndpoint),
    "const evidence = { pid: process.pid, cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME,",
    "providerKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),",
    "forgeTokenPresent: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),",
    "gatewayTokenPresent: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),",
    "runtimeInjectionPresent: Boolean(process.env.NODE_OPTIONS) };",
    `fs.writeFileSync(${JSON.stringify(`p8-${scenario}.json`)},JSON.stringify(evidence));`,
    `sendReceipt(${JSON.stringify(MARKERS[scenario])}, "started");`,
    scenario === "cancel"
      ? `await awaitRelease(${JSON.stringify(MARKERS.cancel)}, "never-released");`
      : `console.log(${JSON.stringify(`${MARKERS[scenario]}_NATIVE_OK`)});`,
  ].join("\n");
  // Base64 avoids shell interpolation of fixture source; this is the model's
  // native exec_command, not an RPC command/exec substitute.
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return `node --input-type=module -e 'await import(${JSON.stringify(moduleUrl)})'`;
}

export async function startWorkerResponses(receiptEndpoint: string) {
  const requests: Array<{
    scenario?: Scenario;
    workerAuth: boolean;
    model: unknown;
    tools: string[];
    completed: boolean;
  }> = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body)) {
        throw new Error("Responses request was not an object");
      }
      const scenario = scenarioFor(body);
      const callId = `p8-native-${scenario}`;
      const completed = (Array.isArray(body.input) ? body.input : []).some(
        (item) => isRecord(item) && item.type === "function_call_output" && item.call_id === callId,
      );
      const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
        isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
      );
      const workerAuth = request.headers.authorization === `Bearer ${WORKER_BEARER}`;
      requests.push({ scenario, workerAuth, model: body.model, tools, completed });
      if (!scenario || !workerAuth) {
        // A local fallback, prepared Gateway profile, or lost user turn must not
        // receive a success-shaped response from this fixture.
        response.writeHead(403).end("Expected worker command-auth and a P8 user turn");
        return;
      }
      if (completed) {
        respond(response, {
          type: "message",
          role: "assistant",
          id: `msg_${scenario}`,
          content: [{ type: "output_text", text: `${MARKERS[scenario]}_OK` }],
        });
      } else {
        respond(response, {
          type: "function_call",
          call_id: callId,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: nativeCommand(scenario, receiptEndpoint),
            yield_time_ms: 30_000,
            max_output_tokens: 1_000,
          }),
        });
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end("Synthetic worker provider failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    close: () => closeWireServer(server),
  };
}

/** Synthetic operator provisioning, not the cloud enrollment/bootstrap proof. */
export async function stageWorkerCodex(params: {
  root: string;
  nodeState: string;
  providerBaseUrl: string;
}) {
  const sourceHome = path.join(params.root, "source-codex");
  const workerHome = path.join(params.nodeState, "codex-runtime");
  const observations = path.join(params.root, "auth-observations");
  await Promise.all(
    [sourceHome, workerHome, observations].map((dir) =>
      fs.mkdir(dir, { recursive: true, mode: 0o700 }),
    ),
  );
  const catalogPath = path.join(sourceHome, "models.json");
  await fs.writeFile(
    catalogPath,
    JSON.stringify({ models: listMockCodexModelInfos([MODEL_REF]) }),
    { mode: 0o600 },
  );
  const sourceHelper = path.join(sourceHome, "token.mjs");
  const workerHelper = path.join(workerHome, "token.mjs");
  const helper = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `const worker = fileURLToPath(import.meta.url) === ${JSON.stringify(workerHelper)};`,
    "if (worker) {",
    'const parentArgs = fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\\0");',
    'const status = fs.readFileSync(`/proc/${process.ppid}/status`, "utf8");',
    "const nodePid = Number(status.match(/^PPid:\\s+(\\d+)/m)?.[1]);",
    'const nativePids = fs.readFileSync(`/proc/${nodePid}/task/${nodePid}/children`, "utf8").trim().split(/\\s+/).map(Number).filter(pid => { try { const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\\0"); return args.includes("app-server") || args.includes("exec-server"); } catch { return false; } });',
    'const evidence = { nativePids, appServerPid: process.ppid, nodePid, parentAppServer: parentArgs.includes("app-server"), home: process.env.HOME, codexHome: process.env.CODEX_HOME };',
    `fs.writeFileSync(path.join(${JSON.stringify(observations)}, process.pid + ".json"), JSON.stringify(evidence), { mode: 0o600 });`,
    "}",
    `process.stdout.write((worker ? ${JSON.stringify(WORKER_BEARER)} : "p8-gateway-synthetic-bearer") + "\\n");`,
  ].join("\n");
  const config = [
    `model = ${JSON.stringify(MODEL_ID)}`,
    'model_provider = "p8-fixture"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.p8-fixture]",
    'name = "P8 synthetic worker"',
    `base_url = ${JSON.stringify(`${params.providerBaseUrl}/v1`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "[model_providers.p8-fixture.auth]",
    'command = "node"',
    `args = [${JSON.stringify(sourceHelper)}]`,
    "",
  ].join("\n");
  const version = createHash("sha256").update(config).update("\0").update(helper).digest("hex");
  const sourceConfig = path.join(sourceHome, "config.toml");
  await fs.writeFile(sourceConfig, config, { mode: 0o600 });
  await fs.writeFile(sourceHelper, helper, { mode: 0o600 });
  await fs.writeFile(workerHelper, helper, { mode: 0o600 });
  await fs.writeFile(
    path.join(workerHome, "config.toml"),
    config.replace(sourceHelper, workerHelper),
    { mode: 0o600 },
  );
  // Publish the version only after both private inputs exist, as enrollment does.
  await fs.writeFile(path.join(workerHome, "version"), version, { mode: 0o600 });
  return {
    sourceHome,
    sourceConfig,
    sourceHelper,
    workerHome,
    observations,
    version,
    command: `codex.app-server.stdio.v1.${version}`,
  };
}

export type NativeMessage = {
  invokeId: string;
  method?: string;
  id?: string | number;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
export type ObservedInvoke = { id: string; command: string; params: Record<string, unknown> };
function rawText(data: RawData) {
  return (
    Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data
  ).toString("utf8");
}

/** Byte-preserving observer: never answers, rewrites, injects, or drops a frame. */
export async function observeWorkerWire(gatewayUrl: string, exactCommand: string) {
  // Workspace artifacts share the node Gateway URL; preserve HTTP as well as WS.
  const httpUrl = new URL(gatewayUrl);
  httpUrl.protocol = "http:";
  const server = createServer((request, response) => {
    const upstream = forwardHttp(
      new URL(request.url ?? "/", httpUrl),
      {
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502).end();
    });
    request.pipe(upstream);
  });
  const sockets = new WebSocketServer({ server });
  const peers = new Set<{ upstream: WebSocket; downstream: WebSocket }>();
  const invokes: ObservedInvoke[] = [];
  const requests: NativeMessage[] = [];
  const responses: NativeMessage[] = [];
  const cancelled = new Set<string>();
  const errors: unknown[] = [];
  const decoders = new Map<string, ReturnType<typeof createNodeDuplexEndpoint>>();
  function receive(id: string, direction: "request" | "response", frame: string) {
    const key = `${id}:${direction}`;
    let decoder = decoders.get(key);
    if (!decoder) {
      decoder = createNodeDuplexEndpoint({
        sendFrame: () => {
          throw new Error("Observer cannot send");
        },
      });
      decoder.onMessage((bytes) => {
        const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (!isRecord(parsed)) {
          throw new Error("Native message is not an object");
        }
        const message: NativeMessage = {
          invokeId: id,
          ...(typeof parsed.method === "string" ? { method: parsed.method } : {}),
          ...(typeof parsed.id === "number" || typeof parsed.id === "string"
            ? { id: parsed.id }
            : {}),
          ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
          ...(isRecord(parsed.result) ? { result: parsed.result } : {}),
        };
        (direction === "request" ? requests : responses).push(message);
      });
      decoders.set(key, decoder);
    }
    decoder.receive(frame);
  }
  function observe(data: RawData, fromGateway: boolean) {
    try {
      const frame: unknown = JSON.parse(rawText(data));
      if (!isRecord(frame)) {
        return;
      }
      const payload = fromGateway ? frame.payload : frame.params;
      if (!isRecord(payload)) {
        return;
      }
      if (
        fromGateway &&
        frame.event === "node.invoke.request" &&
        typeof payload.command === "string" &&
        typeof payload.id === "string"
      ) {
        invokes.push({
          id: payload.id,
          command: payload.command,
          params:
            typeof payload.paramsJSON === "string"
              ? (JSON.parse(payload.paramsJSON) as Record<string, unknown>)
              : isRecord(payload.params)
                ? payload.params
                : {},
        });
      }
      const invokeId =
        fromGateway && frame.event === "node.invoke.input" ? payload.id : payload.invokeId;
      if (
        typeof invokeId !== "string" ||
        !invokes.some((entry) => entry.id === invokeId && entry.command === exactCommand)
      ) {
        return;
      }
      if (fromGateway && frame.event === "node.invoke.cancel") {
        cancelled.add(invokeId);
      }
      if (
        fromGateway &&
        frame.event === "node.invoke.input" &&
        typeof payload.payloadJSON === "string"
      ) {
        receive(invokeId, "request", payload.payloadJSON);
      }
      if (
        !fromGateway &&
        frame.method === "node.invoke.progress" &&
        typeof payload.chunk === "string"
      ) {
        receive(invokeId, "response", payload.chunk);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  sockets.on("connection", (downstream, request) => {
    const upstream = new WebSocket(new URL(request.url ?? "/", gatewayUrl));
    const peer = { upstream, downstream };
    peers.add(peer);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    downstream.on("message", (data, isBinary) => {
      observe(data, false);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push({ data, isBinary });
      }
    });
    upstream.on("open", () => {
      for (const { data, isBinary } of pending.splice(0)) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      observe(data, true);
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });
    const close = () => {
      peers.delete(peer);
      upstream.terminate();
      downstream.terminate();
    };
    upstream.on("error", close);
    downstream.on("error", close);
    upstream.on("close", close);
    downstream.on("close", close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker wire observer did not bind");
  }
  return {
    port: address.port,
    invokes,
    requests,
    responses,
    cancelled,
    errors,
    get connectionCount() {
      return peers.size;
    },
    async close() {
      for (const decoder of decoders.values()) {
        decoder.close();
      }
      for (const peer of peers) {
        peer.upstream.terminate();
        peer.downstream.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      await closeWireServer(server);
    },
  };
}
