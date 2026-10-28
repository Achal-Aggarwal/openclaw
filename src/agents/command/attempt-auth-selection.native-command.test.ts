import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveHarnessAuthProfileSelection } from "./attempt-auth-selection.js";

const mocks = vi.hoisted(() => ({ store: vi.fn() }));
// mock-isolation: Exercise command selection without reading operator credential storage.
vi.mock("../auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreAsync: mocks.store,
}));

beforeEach(() => {
  mocks.store.mockReset().mockResolvedValue({
    version: 1,
    profiles: { "openai:decoy": { type: "api_key", provider: "openai", key: "synthetic-decoy" } },
  });
});

function select(auth: "native-command" | "api-key", source?: "auto" | "user") {
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    models: { providers: { custom: { baseUrl: "https://fixture.example/v1", auth, models: [] } } },
  };
  return resolveHarnessAuthProfileSelection({
    config,
    agentDir: "/fixture",
    workspaceDir: "/fixture/workspace",
    provider: "custom",
    authProfileProvider: "custom",
    harnessRuntime: "codex",
    allowHarnessAuthProfileForwarding: true,
    ...(source ? { sessionAuthProfileId: "openai:decoy", sessionAuthProfileSource: source } : {}),
  });
}

it.each([undefined, "auto"] as const)(
  "does not choose an unrelated OpenAI account for native command auth (%s)",
  async (source) => {
    expect(await select("native-command", source)).toEqual({ authProfileProvider: "custom" });
    expect(mocks.store).not.toHaveBeenCalled();
  },
);

it("retains explicit pins for planner rejection and existing non-command automatic selection", async () => {
  expect(await select("native-command", "user")).toMatchObject({
    authProfileId: "openai:decoy",
    authProfileIdSource: "user",
  });
  expect(await select("api-key")).toMatchObject({
    authProfileId: "openai:decoy",
    authProfileIdSource: "auto",
  });
});
