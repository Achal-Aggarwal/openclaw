import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  createCompletionScope,
  notifyChildStarted,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

afterEach(() => vi.useRealTimers());

async function createSubmissionFixture(acknowledgePredecessor = true) {
  const identity = { kind: "session" as const, agentId: "main", sessionId: "parent-session" };
  const binding = {
    threadId: "parent-thread",
    cwd: "/workspace",
    appServerRuntimeFingerprint: "runtime",
  };
  const bindingStore = createCodexTestBindingStore();
  await bindingStore.mutate(identity, { kind: "set", binding });
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    binding,
  });
  if (!owner) {
    throw new Error("The binding must provide a history owner.");
  }
  const client = createClient();
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "result A" }));
  ensureCodexAppServerClientRuntime(client as never, { agentDir: "/workspace/agent" });
  const unsubscribe = vi.fn(async (_threadId: string) => undefined);
  for (const id of [binding.threadId, "child-thread"]) {
    await retainCodexAppServerLiveThread(client as never, id, unsubscribe);
  }
  const runtime = createRuntime();
  const holds = { client: 0, parent: 0, child: 0 };
  const consume = vi.fn<CodexNativeSubagentSubmissionStore["consume"]>((receipt, guard) =>
    bindingStore.mutate(
      identity,
      { kind: "consume-native-subagent-submission", owner, receipt },
      guard,
    ),
  );
  const submissionStore: CodexNativeSubagentSubmissionStore = {
    assertCurrent: () => {
      const current = bindingStore.read(identity);
      if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
        throw new Error("Submission binding changed.");
      }
    },
    read: () => bindingStore.readNativeSubagentSubmissions(identity, owner),
    record: (receipt, guard) =>
      bindingStore.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt },
        guard,
      ),
    consume,
  };
  const parent = await registerCodexNativeSubagentMonitor({
    client: client as never,
    parentThreadId: binding.threadId,
    requesterSessionKey: "agent:main:main",
    completionScope: createCompletionScope("agent:main:main"),
    historyOwner: owner,
    submissionStore,
    runtime,
    retainClient: () => {
      holds.client += 1;
      return () => {
        holds.client -= 1;
      };
    },
    retainParentThread: (id) => {
      const key = id === binding.threadId ? "parent" : "child";
      const release = protectCodexAppServerLiveThread(client as never, id);
      holds[key] += 1;
      return () => {
        holds[key] -= 1;
        release();
      };
    },
  });
  onTestFinished(async () => {
    await codexNativeSubagentMonitorRuntime.retireParent(client as never, binding.threadId);
    client.close();
    await parent.unregister();
  });
  parent.bindTurn("parent-turn-a");
  await notifyChildStarted(client);
  await client.notify(turnStartedNotification("turn-a"));
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-a",
      status: "completed",
      items: [{ id: "a", type: "agentMessage", text: "result A" }],
    }),
  );
  const acknowledgeInitialResult = (turnId = "parent-turn-a") =>
    client.notify({
      method: "item/completed",
      params: {
        threadId: binding.threadId,
        turnId,
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: binding.threadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "completed", message: "result A" } },
        },
      },
    });
  if (acknowledgePredecessor) {
    await acknowledgeInitialResult();
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(false),
    );
    expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  }
  runtime.deliverAgentHarnessCompletion.mockClear();

  const submit = async (submissionId: string, detach = true) => {
    parent.bindTurn("parent-turn-b");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: binding.threadId,
        turnId: "parent-turn-b",
        item: {
          id: "send-b",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: binding.threadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "running" } },
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({
        parentThreadId: binding.threadId,
        turnId: "parent-turn-b",
        callId: "send-b",
        submissionId,
      }),
    );
    await vi.waitFor(() => expect(submissionStore.read()).toHaveLength(1));
    if (detach) {
      await parent.unregister();
      expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
    }
  };
  return {
    client,
    parent,
    runtime,
    holds,
    consume,
    submissionStore,
    unsubscribe,
    submit,
    acknowledgeInitialResult,
  };
}

const completeChildTurn = (client: ReturnType<typeof createClient>, turnId: string, text: string) =>
  client.notify(
    childTurnCompletedNotification({
      turnId,
      status: "completed",
      items: [{ type: "agentMessage", id: `message-${turnId}`, phase: "final_answer", text }],
    }),
  );

it.each([true, false])(
  "allows parent resume with an unacknowledged follow-up (predecessor acknowledged first=%s)",
  async (acknowledgeFirst) => {
    vi.useFakeTimers();
    const fixture = await createSubmissionFixture(acknowledgeFirst);
    const { client, parent, runtime, holds, consume, submissionStore } = fixture;
    runtime.deliverAgentHarnessCompletion.mockResolvedValue({
      delivered: false,
      path: "direct",
      error: "requester temporarily unavailable",
    });
    await fixture.submit("turn-b", false);
    await client.notify(turnStartedNotification("turn-b", { error: null }));
    if (!acknowledgeFirst) {
      await fixture.acknowledgeInitialResult("parent-turn-b");
    }
    await parent.unregister();
    const releaseForResume = () =>
      releaseCodexBoundLiveThread({
        client: client as never,
        threadId: "parent-thread",
        lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
      });
    await expect(releaseForResume()).rejects.toThrow("claimed by active work; stop it first");
    const receipt = structuredClone(submissionStore.read());
    await completeChildTurn(client, "turn-b", "result B");

    await expect(releaseForResume()).resolves.toBe(true);
    expect(holds.parent).toBe(0);
    expect(isCodexAppServerLiveThreadProtected(client as never, "child-thread")).toBe(false);
    expect(submissionStore.read()).toEqual(receipt);
    expect(consume).not.toHaveBeenCalled();
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "result B" }),
    );

    runtime.deliverAgentHarnessCompletion.mockResolvedValue({ delivered: true, path: "direct" });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(submissionStore.read()).toEqual([]));
    await completeChildTurn(client, "turn-b", "result B");
    expect(consume).toHaveBeenCalledOnce();
    expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  },
);

it("stops observing opaque receipts when existing warm subscriptions expire", async () => {
  const fixture = await createSubmissionFixture();
  const { client, runtime, holds, consume, submissionStore, unsubscribe } = fixture;
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  await fixture.submit("815dc55d-2d19-4bfe-9fd3-038ce4d6aada");
  const receipt = structuredClone(submissionStore.read());
  const reads = () =>
    client.request.mock.calls.filter(([method]) => method === "thread/read").length;
  // The existing client-runtime owner expires unprotected subscriptions after 30 minutes.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(hasCodexAppServerLiveThread(client as never, "parent-thread")).toBe(false);
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(false);
  expect(unsubscribe.mock.calls.map(([id]) => id).toSorted()).toEqual([
    "child-thread",
    "parent-thread",
  ]);
  const readsAtExpiry = reads();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads()).toBe(readsAtExpiry);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
  expect(submissionStore.read()).toEqual(receipt);
  expect(consume).not.toHaveBeenCalled();
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await client.notify(turnStartedNotification(receipt[0]!.submissionId));
  expect(submissionStore.read()).toEqual(receipt);
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});

it("admits a delayed exact start under warm backing and retains its completion ownership", async () => {
  const fixture = await createSubmissionFixture();
  const { client, runtime, holds, submissionStore } = fixture;
  await releaseCodexAppServerLiveThread(client as never, "parent-thread");
  expect(hasCodexAppServerLiveThread(client as never, "child-thread")).toBe(true);
  await fixture.submit("turn-b");
  await client.notify(turnStartedNotification("turn-b"));
  const runId = "codex-thread:child-thread:turn:turn-b";
  expect(submissionStore.read()).toHaveLength(1);
  expect(isCodexAppServerLiveThreadClaimed(client as never, "child-thread")).toBe(true);
  expect(holds.client).toBe(1);
  expect(holds.parent).toBe(1);
  await expect(releaseCodexAppServerLiveThread(client as never, "child-thread")).resolves.toBe(
    false,
  );
  await client.notify(
    childTurnCompletedNotification({
      turnId: "turn-b",
      status: "completed",
      items: [{ id: "b", type: "agentMessage", text: "result B" }],
    }),
  );
  await vi.waitFor(() => expect(submissionStore.read()).toEqual([]));
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ childSessionKey: runId, result: "result B" }),
  );
  expect(holds).toEqual({ client: 0, parent: 0, child: 0 });
});
