import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockServerTestHarness,
  getJson,
  postJson,
  postResponses,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const completion = (name: string) => ({
  role: "developer" as const,
  content: `[Internal task completion event]\nTask: qa-terminal-${name}\nResult: child result`,
});
const failure = {
  type: "qa_terminal_completion_failure",
  code: "qa_terminal_completion_failure",
  message: "Method Not Allowed",
};

beforeEach(() => vi.stubEnv("OPENAI_CUSTOM_HEADERS", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("terminal completion direct-fallback provider fixture", () => {
  it.each(["visible", "fallback", "restart"])(
    "fails only the current %s completion through both Responses HTTP modes",
    async (name) => {
      const server = await startMockServer();
      for (const stream of [false, true]) {
        const response = await postResponses(server, {
          model: "qa-model",
          input: [completion(name)],
          stream,
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toEqual({ error: failure });
      }
      expect(await getJson(server, "/debug/requests")).toEqual([
        expect.objectContaining({
          outcome: "error",
          errorCode: failure.code,
          terminalCompletionCase: name,
        }),
        expect.objectContaining({
          outcome: "error",
          errorCode: failure.code,
          terminalCompletionCase: name,
        }),
      ]);
      expect(await getJson(server, "/debug/inflight-requests")).toEqual([]);
    },
  );

  it.each([false, true])("projects the real SDK failure with stream=%s", async (stream) => {
    const server = await startMockServer();
    const client = new OpenAI({
      baseURL: `${server.baseUrl}/v1`,
      apiKey: "qa-synthetic-key",
      adminAPIKey: null,
      organization: null,
      project: null,
      maxRetries: 2,
    });
    await expect(
      client.responses.create({
        model: "qa-model",
        input: [completion("fallback")],
        stream,
      }),
    ).rejects.toMatchObject({
      status: 405,
      type: failure.type,
      code: failure.code,
      message: "405 Method Not Allowed",
      error: failure,
    });
    // A 405 is not one of the SDK's retryable statuses, even with retry budget.
    expect(await getJson(server, "/debug/requests")).toHaveLength(1);
  });

  it.each([
    ["empty completion", [completion("empty")]],
    ["silent completion", [completion("silent")]],
    ["private completion", [completion("private")]],
    ["race completion", [completion("race")]],
    ["unselected completion", [completion("unrelated")]],
    ["kickoff", [{ role: "user", content: "Subagent terminal reply QA check: fallback." }]],
    ["worker", [{ role: "user", content: "Subagent terminal reply QA worker: fallback." }]],
    [
      "settled wake",
      [
        completion("fallback"),
        {
          role: "user",
          content: "[Subagent Context] Every subagent in this batch has now settled.",
        },
      ],
    ],
    ["fresh user fence", [completion("fallback"), { role: "user", content: "Reply exactly: OK" }]],
    [
      "quoted completion history",
      [
        {
          role: "user",
          content: `<conversation_context>\n[user]\n${completion("fallback").content}\n</conversation_context>\n\nCurrent user request:\nReply exactly: OK`,
        },
      ],
    ],
  ] as const)("preserves %s", async (_name, input) => {
    const server = await startMockServer();
    const response = await postResponses(server, { model: "qa-model", input });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(failure.code);
    expect(await getJson(server, "/debug/last-request")).toMatchObject({ outcome: "success" });
  });

  it.each(["visible", "fallback", "restart"])(
    "does not inject the Responses-only failure into Anthropic %s",
    async (name) => {
      const server = await startMockServer();
      const response = await postJson(server, "/v1/messages", {
        model: "qa-model",
        max_tokens: 256,
        messages: [{ role: "user", content: completion(name).content }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(failure.code);
      expect(await getJson(server, "/debug/last-request")).toMatchObject({ outcome: "success" });
    },
  );
});
