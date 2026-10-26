import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import {
  childTurnCompletedNotification,
  createClient,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";
import { bindingStoreKey } from "./session-binding-record.js";

setupRunAttemptTestHooks();

async function startAssignment(observeTurn = true) {
  const f = await fixture();
  const client = createClient();
  const parent = await f.register(client);
  await parent.ready;
  parent.bindTurn("parent-turn");
  await f.spawn(client, observeTurn);
  return { f, client, parent };
}

describe("native pending assignment inventory delivery and restoration", () => {
  it("restores aliases once across clients while delivering distinct child turns", async () => {
    const f = await fixture();
    const assignments = ["first-turn", "second-turn"].map((turnId) => ({
      runId: `codex-thread:child-thread:turn:${turnId}`,
      childThreadId: "child-thread",
      nativeTurnId: turnId,
      nativeParentThreadId: "parent-thread",
      owner: f.historyOwner(),
    }));
    for (const assignment of assignments) {
      await f.store.mutate(
        f.identity,
        {
          kind: "record-native-subagent-assignment",
          owner: f.historyOwner(),
          assignment,
        },
        () => {},
      );
    }
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toHaveLength(2);
    const row = f.state.lookup(bindingStoreKey(f.identity));
    assert(row?.state === "active");
    f.state.register(bindingStoreKey(f.identity), {
      ...row,
      nativeSubagentAssignments: {
        version: 1,
        assignments: [{ ...assignments[0]!, runId: "codex-thread:child-thread" }, ...assignments],
      },
    });
    const client = createClient();
    const peerClient = createClient();
    const first = threadRead({
      turnId: "first-turn",
      result: "First result",
      resultPhase: "final_answer",
    });
    const second = threadRead({
      turnId: "second-turn",
      result: "Second result",
      resultPhase: "final_answer",
    });
    assert(first.thread.turns && second.thread.turns);
    first.thread.turns.push(...second.thread.turns);
    client.setThreadRead("child-thread", first);
    peerClient.setThreadRead("child-thread", first);
    const parent = await f.register(client);
    let peer: Awaited<ReturnType<typeof f.register>> | undefined;
    try {
      await parent.ready;
      peer = await f.register(peerClient);
      await peer.ready;
      await peer.unregister();
      expect(f.deliver).not.toHaveBeenCalled();
      await parent.unregister();
      expect(f.deliver.mock.calls.map(([completion]) => completion.result)).toEqual([
        "First result",
        "Second result",
      ]);
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    } finally {
      await peer?.unregister();
      await parent.unregister();
      client.close();
      peerClient.close();
    }
  });

  it.each(["rejected write", "lost reply"])(
    "retries retirement after %s without resending the completion",
    async (failure) => {
      const { f, client, parent } = await startAssignment();
      f.deliver.mockResolvedValue({ delivered: false, path: "none", recoveryBlocked: true });
      const mutate = f.store.mutate.bind(f.store);
      let reject = true;
      vi.spyOn(f.store, "mutate").mockImplementation(async (identity, mutation, guard) => {
        if (
          mutation.kind === "consume-native-subagent-assignment" &&
          mutation.undelivered &&
          reject
        ) {
          reject = false;
          if (failure === "lost reply") {
            await mutate(identity, mutation, guard);
            throw new Error("Binding retirement reply lost after commit");
          }
          return false;
        }
        return await mutate(identity, mutation, guard);
      });
      await client.notify(
        childTurnCompletedNotification({
          status: "completed",
          items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Result" }],
        }),
      );
      await parent.unregister();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toHaveLength(
        failure === "lost reply" ? 0 : 1,
      );
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      const settled = await f.register(client);
      await settled.ready;
      await settled.unregister();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
      expect(await readVisibleSessionTranscriptMessageEntries(f.identity)).toHaveLength(1);
      client.close();
    },
  );

  it.each(["observed turn", "canonical locator", "resumed turn", "different turn"])(
    "reconciles a pending assignment's %s during its history read",
    async (change) => {
      const f = await fixture();
      const initial = {
        runId: "codex-thread:child-thread",
        childThreadId: "child-thread",
        ...(change === "observed turn" ? {} : { nativeTurnId: "child-turn" }),
        nativeParentThreadId: "parent-thread",
        owner: f.historyOwner(),
      };
      await f.store.mutate(
        f.identity,
        { kind: "record-native-subagent-assignment", owner: f.historyOwner(), assignment: initial },
        () => {},
      );
      const entered = createDeferred<void>();
      const history = createDeferred<ReturnType<typeof threadRead>>();
      const client = createClient();
      client.setThreadReadFactory("child-thread", () => {
        entered.resolve();
        return history.promise;
      });
      const parent = await f.register(client);
      const recovered = threadRead({
        turnId: change === "resumed turn" ? "resumed-turn" : "child-turn",
        result: "Recovered result",
        resultPhase: "final_answer",
      });
      if (change === "resumed turn") {
        const interrupted = threadRead({ turnId: "child-turn", status: "interrupted" });
        assert(recovered.thread.turns && interrupted.thread.turns);
        recovered.thread.turns.unshift(...interrupted.thread.turns);
      }
      try {
        await entered.promise;
        if (change === "different turn") {
          await f.store.mutate(
            f.identity,
            {
              kind: "consume-native-subagent-assignment",
              owner: f.historyOwner(),
              assignment: initial,
            },
            () => {},
          );
        }
        const surviving = {
          ...initial,
          runId:
            change === "canonical locator"
              ? "codex-thread:child-thread:turn:child-turn"
              : change === "different turn"
                ? "codex-thread:child-thread:turn:other-turn"
                : initial.runId,
          nativeTurnId:
            change === "resumed turn"
              ? "resumed-turn"
              : change === "different turn"
                ? "other-turn"
                : "child-turn",
        };
        await f.store.mutate(
          f.identity,
          {
            kind: "record-native-subagent-assignment",
            owner: f.historyOwner(),
            assignment: surviving,
          },
          () => {},
        );
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        if (change === "different turn") {
          expect(f.deliver).not.toHaveBeenCalled();
          expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([
            surviving,
          ]);
        } else {
          expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              childSessionKey: surviving.runId,
              result: "Recovered result",
            }),
          );
          expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
        }
      } finally {
        history.resolve(recovered);
        await parent.ready;
        await parent.unregister();
        client.close();
      }
    },
  );

  it("does not restore an assignment retired while native history was being read", async () => {
    const { f, client, parent } = await startAssignment();
    f.deliver.mockResolvedValue({ delivered: false, path: "none", error: "Unavailable" });
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Result" }],
      }),
    );
    await parent.unregister();
    const entered = createDeferred<void>();
    const history = createDeferred<ReturnType<typeof threadRead>>();
    const replacementClient = createClient();
    replacementClient.setThreadReadFactory("child-thread", () => {
      entered.resolve();
      return history.promise;
    });
    const replacement = await f.register(replacementClient);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    const attempts = f.deliver.mock.calls.length;
    history.resolve(
      threadRead({ turnId: "child-turn", result: "Result", resultPhase: "final_answer" }),
    );
    await replacement.ready;
    await replacement.unregister();
    expect(f.deliver).toHaveBeenCalledTimes(attempts);
    expect(f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
    client.close();
    replacementClient.close();
  });
});
