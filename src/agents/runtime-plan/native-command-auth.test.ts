import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ModelsConfigSchema } from "../../config/zod-schema.core.js";
import {
  buildAgentHarnessSupportContext,
  resolveAgentHarnessPreparedAuthSupport,
} from "../harness/support.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { resolveApiKeyForProviderCore } from "../model-auth-provider.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

const configuredModel = {
  id: "gpt-test",
  name: "Test model",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
  agentRuntime: { id: "codex" },
};
const provider = {
  auth: "native-command" as const,
  api: "openai-responses" as const,
  baseUrl: "https://inference.example.test/v1",
  models: [configuredModel],
};
const config: OpenClawConfig = { models: { providers: { autodev: provider } } };
const authProfileStore = {
  version: 1 as const,
  profiles: {
    "openai:decoy": { type: "api_key" as const, provider: "openai", key: "synthetic-profile-key" },
    "autodev:decoy": { type: "api_key" as const, provider: "autodev", key: "synthetic-custom-key" },
  },
};
const params = {
  provider: "autodev",
  modelId: "gpt-test",
  config,
  env: { OPENAI_API_KEY: "synthetic-ambient-key" },
  authProfileStore,
  harnessId: "codex",
  harnessRuntime: "codex",
  harnessAuthBootstrap: "harness" as const,
};

describe("custom provider native command auth", () => {
  it("exposes only the declared Codex runtime without host credentials", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: config,
      authStore: authProfileStore,
      env: params.env,
      syntheticAuthProviderRefs: ["codex"],
    });
    const ref = {
      runtimeId: "codex",
      modelId: "gpt-test",
      api: provider.api,
      baseUrl: provider.baseUrl,
    };
    expect(resolver.evaluateRuntimeModelAuth("autodev", ref)).toMatchObject({
      availability: true,
      selectedAuthMode: "native-command",
      runtimeAuth: { id: "codex", source: "native" },
    });
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", { ...ref, runtimeId: "openclaw" }).availability,
    ).not.toBe(true);
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", {
        ...ref,
        baseUrl: "https://other.example.test/v1",
      }).availability,
    ).not.toBe(true);
    expect(resolver.resolveProviderAuthAvailability("autodev")).toBe(false);
  });

  it("prepares an implicit harness attempt without forwarding ambient or stored credentials", async () => {
    expect(ModelsConfigSchema.safeParse(config.models).success).toBe(true);
    const prepared = prepareAuthFixture(params);
    expect(prepared.attempts.map((attempt) => attempt.kind)).toEqual(["implicit"]);
    expect(prepared.plan.harnessAuthProvider).toBe("openai");
    expect(prepared.plan.forwardedAuthProfileId).toBeUndefined();
    expect(prepared.plan.credentialSource).toEqual({ kind: "none" });
    expect(resolveAgentHarnessPreparedAuthSupport({ plan: prepared.plan })).toEqual({
      source: "harness",
      mode: "native-command",
    });
    expect(
      buildAgentHarnessSupportContext({
        config,
        provider: "autodev",
        modelId: "gpt-test",
        requestedRuntime: "codex",
        providerOwnership: { status: "unowned" },
      }).modelProvider?.nativeCommandAuth,
    ).toEqual({ runtimeId: "codex" });
    await expect(
      resolveApiKeyForProviderCore({
        provider: "autodev",
        cfg: config,
        store: authProfileStore,
      }),
    ).rejects.toThrow("host credentials cannot be used");
  });

  it("refuses host execution and mixed declared credentials", () => {
    expect(() =>
      prepareAuthFixture({ ...params, harnessId: "openclaw", harnessRuntime: "openclaw" }),
    ).toThrow("explicit Codex");
    expect(() =>
      prepareAuthFixture({
        ...params,
        config: { models: { providers: { autodev: { ...provider, apiKey: "synthetic-key" } } } },
      }),
    ).toThrow("cannot be combined");
  });
  it.each([
    { apiKey: "synthetic-key" },
    { api: "openai-completions" },
    { baseUrl: "http://inference.example.test/v1" },
    { baseUrl: "https://user:secret@inference.example.test/v1" },
    { headers: { "x-custom": "override" } },
    { request: { headers: { "x-custom": "override" } } },
    { authHeader: false },
    { timeoutSeconds: 15 },
    { models: [{ ...configuredModel, agentRuntime: undefined }] },
  ] satisfies Partial<ModelProviderConfig>[])(
    "rejects incompatible native route %j",
    (override) => {
      expect(() =>
        prepareAuthFixture({
          ...params,
          config: { models: { providers: { autodev: { ...provider, ...override } } } },
        }),
      ).toThrow("Native command auth");
    },
  );

  it("accepts a provider-level runtime but refuses profile pins and owned provider IDs", () => {
    const providerRuntime = {
      ...provider,
      agentRuntime: { id: "codex" },
      models: [{ ...configuredModel, agentRuntime: undefined }],
    };
    expect(
      prepareAuthFixture({
        ...params,
        config: { models: { providers: { autodev: providerRuntime } } },
      }).attempts[0]?.kind,
    ).toBe("implicit");
    expect(() => prepareAuthFixture({ ...params, sessionAuthProfileId: "openai:decoy" })).toThrow(
      "profile binding",
    );
    expect(
      buildAgentHarnessSupportContext({
        config,
        provider: "autodev",
        modelId: "gpt-test",
        requestedRuntime: "codex",
        providerOwnership: { status: "owned", pluginIds: ["fixture"] },
      }).modelProvider?.nativeCommandAuth,
    ).toBeUndefined();
  });
});
