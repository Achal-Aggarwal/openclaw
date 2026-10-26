import { expect, it } from "vitest";
import type { OAuthCredential } from "../../auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "../../model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import { createPreparedAccountCatalogAccess } from "../../prepared-model-runtime.catalog-auth.js";
import { prepareEmbeddedAccessProgramGuard } from "./access-program.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const profileId = "openai:default";
const route = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
const discovered: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "access-1",
  refresh: "refresh-1",
  expires: 1_000,
  accountId: "account-a",
  email: "user@example.test",
};

function attemptWith(credential: OAuthCredential) {
  const snapshot: ModelCatalogSnapshot = {
    entries: [],
    routeVariants: [],
    providerOutcomes: [
      {
        provider: "openai",
        profileId,
        status: "ready",
        modelAccessPrograms: [
          {
            modelId: "synthetic-model",
            runtimeId: "openclaw",
            ...route,
            cyber: ["standard", "daybreak_blue"],
          },
        ],
      },
    ],
  };
  setPreparedModelFullCatalogAuth(snapshot, {
    authStore: { version: 1, profiles: { [profileId]: discovered } },
  } as Parameters<typeof setPreparedModelFullCatalogAuth>[1]);
  return {
    provider: "openai",
    modelId: "synthetic-model",
    cyberAccessProgram: "daybreak_blue",
    authProfileId: profileId,
    authProfileStore: { version: 1, profiles: { [profileId]: credential } },
    runtimePlan: { auth: { modelRoute: route, selectedAuthMode: "oauth" } },
    preparedModelRuntime: {
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
      readFullModelCatalog: () => snapshot,
      isCurrent: () => true,
    },
  } as unknown as EmbeddedRunAttemptParams;
}

it("keeps the discovered program across an OAuth refresh of the same account", async () => {
  await expect(prepareEmbeddedAccessProgramGuard(attemptWith(discovered))).resolves.toBeTypeOf(
    "function",
  );
  const refreshed = { ...discovered, access: "access-2", refresh: "refresh-2", expires: 2_000 };
  await expect(prepareEmbeddedAccessProgramGuard(attemptWith(refreshed))).resolves.toBeTypeOf(
    "function",
  );
});

it("never reuses discovered programs for a different account under the same profile", async () => {
  for (const credential of [
    { ...discovered, access: "access-2", accountId: "account-b" },
    { ...discovered, access: "access-2", accountId: undefined },
    { ...discovered, access: "access-2", accountId: undefined, email: "user@example.test" },
    { ...discovered, access: "access-2", issuer: "https://other.example.test" },
    { ...discovered, access: "access-2", email: "other@example.test" },
  ]) {
    await expect(prepareEmbeddedAccessProgramGuard(attemptWith(credential))).rejects.toMatchObject({
      code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE",
    });
  }
});
