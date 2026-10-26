import { afterEach, expect, it, vi } from "vitest";
import { createApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import {
  createDraftFixture,
  readyChatRoute,
  resetSubmissionMocks,
} from "./draft-submission-flow.test-support.ts";

const runtimeImport = vi.hoisted(() => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
}));

vi.mock("../../app/session-placement-startup.runtime.ts", async () => {
  runtimeImport.entered.resolve();
  await runtimeImport.release.promise;
  throw new Error("App placement runtime unavailable");
});

afterEach(async () => {
  runtimeImport.release.resolve();
  await vi.dynamicImportSettled();
  resetSubmissionMocks();
});

it("creates and retains placement while its app runtime is held, then exposes its load failure", async () => {
  const { context, flow } = createDraftFixture({
    methods: ["sessions.create", "sessions.dispatch"],
  });
  const startup = createApplicationPlacementStartup({
    gateway: context.gateway,
    sessions: context.sessions,
    chatSubmissions: context.chatSubmissions,
  });
  Object.assign(context, { placementStartup: startup });
  const sessionKey = "agent:main:held-placement";
  vi.mocked(context.sessions.createResult).mockResolvedValue({
    key: sessionKey,
    initialRun: { status: "idle" },
  });
  vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
  expect(
    flow.pendingPlacement.stageCreate({
      agentId: "main",
      target: { kind: "device", deviceId: "worker-a" },
      message: "Retain this placement prompt",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: { agentId: "main", message: "", worktree: true },
    }),
  ).not.toBeNull();
  flow.pendingPlacement.retryAllowed = true;
  try {
    flow.preloadPlacementOperations();
    await runtimeImport.entered.promise;
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(startup.get(sessionKey)).toMatchObject({
      phase: "pending",
      initialTurn: { text: "Retain this placement prompt" },
    });
    expect(flow.error).toBeNull();

    runtimeImport.release.resolve();
    await vi.dynamicImportSettled();
    expect(startup.get(sessionKey)).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("App placement runtime unavailable"),
      retryable: true,
      initialTurn: { text: "Retain this placement prompt" },
    });
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
  } finally {
    startup.dispose();
    flow.disconnect();
  }
});
