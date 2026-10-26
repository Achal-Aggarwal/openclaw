import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import type { SessionsListResult } from "../../ui/src/api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../ui/src/lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  registerSubagentRun,
  withSubagentKillOwner,
} from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import * as swarm from "../agents/subagents/swarm/swarm-scheduler.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  beginSessionEffect,
  getSessionMutationCount,
  getSessionControllerWorkCount,
  type SessionEffectRef,
} from "../sessions/session-controller.lifecycle.js";
import { observeGatewayConnectionWork } from "./server-held-work.test-support.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import * as fixture from "./test-helpers.js";

let gateway: Awaited<ReturnType<typeof fixture.createGatewaySuiteHarness>>;
let connectionObserver: Awaited<ReturnType<typeof observeGatewayConnectionWork>>;
fixture.installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    connectionObserver = await observeGatewayConnectionWork();
    try {
      gateway = await fixture.createGatewaySuiteHarness();
    } finally {
      connectionObserver.stopCapture();
    }
  },
  cleanup: async () => {
    await runQaGatewayFixture(
      async () => gateway?.close(),
      () => connectionObserver.restore(),
      async () => {
        await settleSubagentRegistryPersistenceWork();
        await resetSubagentRegistryForTests({ persist: false });
      },
    );
  },
});

await import("./server.js");

for (const [suffix, name] of [
  ["fault", "chat.abort interrupts all siblings before cleanup and preserves failure accounting"],
  [
    "replacement",
    "typed Stop rejects a replaced parent while retaining its accepted child cancellation",
  ],
] as const) {
  test(name, async () => {
    const fault = suffix === "fault";
    const replaceParent = suffix === "replacement";
    const parentRunId = `parent-${suffix}`;
    const parentKey = `agent:main:sibling-abort-${suffix}`;
    const groupId = `sibling-abort-${suffix}`;
    const running = Array.from(
      { length: fault ? 8 : 1 },
      (_, index) => `running-${suffix}-${index}`,
    );
    const firstRunId = expectDefined(running[0], "first running child");
    const queued = fault ? [`queued-${suffix}-0`, `queued-${suffix}-1`] : [];
    const selected = [...running, ...queued];
    const failedRunId = fault ? running[3] : undefined;
    const sessionKey = (runId: string) => `agent:main:subagent:${runId}`;
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const parentSessionId = `parent-session-${suffix}`;
    const replacementScope = {
      storePath,
      agentId: "main",
      sessionKey: parentKey,
      sessionId: `replacement-session-${suffix}`,
    };
    const replacementCanary = "The replacement conversation must survive the earlier Stop.";
    let replacementBefore: Awaited<ReturnType<typeof sessions.loadTranscriptEvents>> | undefined;
    fixture.testState.sessionStorePath = storePath;
    const seedSession = (key: string, id: string) =>
      writeSubagentSessionEntry({
        stateDir,
        agentId: "main",
        sessionKey: key,
        defaultSessionId: id,
      });
    // Prior cases still have Gateway-owned monitors; preserve their rows.
    await seedSession(parentKey, parentSessionId);

    const socket = await gateway.openWs();
    const parentStarted = createDeferred<AgentCommandOpts>();
    const parentFinish = createDeferred();
    const leases: SessionEffectRef[] = [];
    const releasedLeases = new Set<SessionEffectRef>();
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const slotReleaseResults: boolean[] = [];
    const start = vi.fn(async () => {});
    const reserve = (runId: string, maxConcurrent: number) =>
      swarm.reserveSwarmRun({ groupId, runId, maxConcurrent, activeRunIds: running });
    let parentRequestId: string | undefined;
    let parentTerminal: Promise<PromiseSettledResult<unknown>> | undefined;
    let abortResponse: ReturnType<typeof fixture.rpcReq> | undefined;
    let abortOutcome:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof fixture.rpcReq>>>>
      | undefined;
    let responseSettled = false;
    let acceptedKillIntent: SubagentRunRecord["killIntent"];
    const expectResponse = (
      response: Awaited<ReturnType<typeof fixture.rpcReq>>,
      shape: Record<string, unknown>,
    ) => expect(response, JSON.stringify(response.error)).toMatchObject(shape);
    const runtimeKey = (runId: string) => getSubagentRunRuntimeKey(subagentRuns.get(runId)!);

    const cancellationInspected = createDeferred();
    // Hold the child's kill owner: an aborted parent no longer delays confirmation,
    // which can legitimately retire a non-collecting child before this inspection.
    const cancellationOwner = replaceParent
      ? withSubagentKillOwner(firstRunId, () => cancellationInspected.promise)
      : undefined;
    await runQaGatewayFixture(
      async () => {
        await fixture.connectOk(socket, {
          scopes: ["operator.read", "operator.write"],
          prePairDevice: true,
        });
        fixture.agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.abortSignal).toBeInstanceOf(AbortSignal);
          await command.onExecutionStarted?.();
          command.abortSignal!.addEventListener("abort", () => parentFinish.resolve(), {
            once: true,
          });
          parentStarted.resolve(command);
          await parentFinish.promise;
          command.abortSignal!.throwIfAborted();
        });
        const accepted = await fixture.rpcReq(socket, "agent", {
          sessionKey: parentKey,
          message: "Keep this synthetic parent active until Stop",
          idempotencyKey: parentRunId,
        });
        parentRequestId = accepted.id;
        expectResponse(accepted, {
          ok: true,
          payload: { runId: parentRunId, status: "accepted" },
        });
        const parent = await parentStarted.promise;
        expect(fixture.agentCommandMock).toHaveBeenCalledTimes(1);

        for (const runId of selected) {
          const childStorePath = await seedSession(sessionKey(runId), `${runId}-session`);
          if (running.includes(runId)) {
            // Recovery must observe the live owner when the run is registered.
            leases.push(
              await beginSessionEffect({
                scope: storePath,
                identities: [sessionKey(runId), `${runId}-session`],
                resolveGatewayContext: expectDefined(
                  connectionObserver.context,
                  "Gateway fixture context",
                ).resolveGatewayContext,
                run: {
                  runId,
                  sessionKey: sessionKey(runId),
                  sessionId: `${runId}-session`,
                  agentId: "main",
                },
                assertAllowed: () => {},
                onInterrupt: () => {
                  interrupted.push(runId);
                  firstInterrupted.resolve();
                  slotReleaseResults.push(swarm.releaseSwarmRun(runId));
                  if (runId === failedRunId) {
                    throw new Error("synthetic sibling interruption failure");
                  }
                  return { runId };
                },
              }),
            );
          }
          if (queued.includes(runId)) {
            expect(reserve(runId, 8)).toBe(true);
          }
          await registerSubagentRun({
            runId,
            childSessionKey: sessionKey(runId),
            childAgentId: "main",
            sessionEntry: sessions.loadExactSessionEntryReadOnly({
              storePath: childStorePath,
              sessionKey: sessionKey(runId),
            })?.entry,
            requesterSessionKey: parentKey,
            requesterAgentId: "main",
            requesterTurnRunId: parentRunId,
            requesterDisplayKey: parentKey,
            task: runId,
            cleanup: "keep",
            collect: !replaceParent,
            groupId,
            queued: queued.includes(runId),
            expectsCompletionMessage: false,
          });
          if (queued.includes(runId)) {
            swarm.activateSwarmRun({ groupId, runId, start, onStartFailure: () => true });
          }
        }
        if (queued.length === 0) {
          expect(reserve(firstRunId, 1)).toBe(false);
        }
        expect(running.every((runId) => swarm.isSwarmRunActive(runId))).toBe(true);
        for (const runId of queued) {
          expect(swarm.isSwarmRunWaitingForCapacity(runId, runtimeKey(runId))).toBe(true);
        }
        expect(leases).toHaveLength(running.length);
        for (const lease of leases) {
          void lease.released.then(() => {
            releasedLeases.add(lease);
          });
        }
        const activeAdmissionCount = getSessionControllerWorkCount();
        expect(activeAdmissionCount).toBeGreaterThanOrEqual(running.length);
        expect(start).not.toHaveBeenCalled();

        parentTerminal = Promise.allSettled([
          fixture.onceMessage(
            socket,
            (frame) =>
              frame.type === "res" &&
              frame.id === parentRequestId &&
              frame.payload?.status !== "accepted",
          ),
        ]).then(([result]) => result);
        if (replaceParent) {
          const history = await fixture.rpcReq<{
            sessionId: string;
            sessionInfo: { activeLeafEntryId: string | null };
          }>(socket, "chat.history", { sessionKey: parentKey });
          expect(history.ok).toBe(true);
          const payload = expectDefined(history.payload, "parent history");
          expect(payload.sessionId).toBe(parentSessionId);
          expect(payload.sessionInfo).toHaveProperty("activeLeafEntryId");
          fixture.embeddedRunMock.activeIds.add(`${firstRunId}-session`);
          abortResponse = fixture.rpcReq(socket, "chat.send", {
            sessionKey: parentKey,
            message: "/stop",
            sessionId: parentSessionId,
            expectedLeafEntryId: payload.sessionInfo.activeLeafEntryId,
            idempotencyKey: "stop-parent-replaced-during-drain",
          });
        } else {
          abortResponse = fixture.rpcReq(socket, "chat.abort", {
            sessionKey: parentKey,
            agentId: "main",
            runId: parentRunId,
          });
        }
        abortOutcome = Promise.allSettled([abortResponse]).then(([outcome]) => {
          responseSettled = true;
          return expectDefined(outcome, "Stop outcome");
        });
        await awaitGateBeforeSettlement(
          firstInterrupted.promise,
          abortOutcome,
          "chat.abort completed before interrupting its children",
        );
        // No child may make sibling interruption wait for this fixture-owned cleanup.
        await expect.poll(() => interrupted.toSorted(), { timeout: 2_000 }).toEqual(running);
        expect(parent.abortSignal!.aborted).toBe(true);
        expect(slotReleaseResults).toEqual(running.map(() => true));
        expect(releasedLeases.size).toBe(0);
        expect(getSessionControllerWorkCount()).toBeGreaterThanOrEqual(running.length);
        expect(responseSettled).toBe(false);
        expect(start).not.toHaveBeenCalled();
        if (replaceParent) {
          acceptedKillIntent = structuredClone(
            expectDefined(subagentRuns.get(firstRunId)?.killIntent, "accepted child kill intent"),
          );
          sessions.replaceSessionEntrySync(replacementScope, {
            sessionId: replacementScope.sessionId,
            lifecycleRevision: "replacement",
            updatedAt: Date.now(),
          });
          expect(
            sessions.appendTranscriptMessageSync(replacementScope, {
              eventId: "replacement-canary",
              message: { role: "user", content: replacementCanary },
              parentId: null,
            }).ok,
          ).toBe(true);
          replacementBefore = await sessions.loadTranscriptEvents(replacementScope);
          expect(replacementBefore).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ content: replacementCanary }),
            }),
          );
        }
        for (const lease of leases.toReversed()) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
        if (replaceParent) {
          expectResponse(outcome.value, {
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              details: { reason: "active-leaf-changed" },
            },
          });
          expect(fixture.embeddedRunMock.abortCalls).not.toContain(`${firstRunId}-session`);
          expect(fixture.embeddedRunMock.activeIds.has(`${firstRunId}-session`)).toBe(true);
          expect(sessions.loadExactSessionEntryReadOnly(replacementScope)?.entry.sessionId).toBe(
            replacementScope.sessionId,
          );
          expect(await sessions.loadTranscriptEvents(replacementScope)).toEqual(replacementBefore);
        } else {
          expectResponse(outcome.value, {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: expect.stringContaining("synthetic sibling interruption failure"),
            },
          });
        }
        const persistedRuns = listRunsForControllerFromRuns(
          loadSubagentRegistryFromSqlite(),
          parentKey,
        );
        expect(persistedRuns.map((run) => run.runId).toSorted()).toEqual(selected.toSorted());
        for (const run of persistedRuns) {
          const { runId } = run;
          if (replaceParent && run.killIntent) {
            // Bookkeeping may fail after interruption; the exact durable claim remains recoverable.
            expect(run.killIntent).toEqual(acceptedKillIntent);
          } else if (runId === failedRunId) {
            expect(run.execution.status).toBe("running");
            expect(run.execution.endedAt).toBeUndefined();
          } else {
            expect(run).toMatchObject({
              endedReason: "subagent-killed",
              execution: { status: "terminal" },
            });
          }
          if (replaceParent && !run.killIntent) {
            expect(run.killReconciliation).toMatchObject({
              killedAt: expectDefined(acceptedKillIntent, "accepted child kill intent").requestedAt,
              taskCancellationAccepted: true,
            });
          }
          if (queued.includes(runId)) {
            expect(run.execution.startedAt).toBeUndefined();
            expect(swarm.ownsSwarmRunReservation(runId, runtimeKey(runId))).toBe(false);
          }
        }
        expect(start).not.toHaveBeenCalled();
      },
      async () => {
        // Cleanup is unconditional, including the expected pre-fix fanout assertion failure.
        cancellationInspected.resolve();
        await cancellationOwner;
        for (const lease of leases) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome?.status === "rejected") {
          throw outcome.reason;
        }
      },
      async () => {
        parentFinish.resolve();
        const terminal = await parentTerminal;
        if (terminal?.status === "rejected") {
          throw terminal.reason;
        }
      },
      async () => {
        const reservationReleases: Promise<void>[] = [];
        try {
          for (const runId of selected) {
            if (replaceParent) {
              fixture.embeddedRunMock.activeIds.delete(`${runId}-session`);
            }
            const hold = swarm.holdQueuedSwarmRun(runId);
            if (hold) {
              hold.withdraw();
              reservationReleases.push(hold.release());
            }
            swarm.releaseSwarmRun(runId);
          }
          socket.close();
        } finally {
          await Promise.all(reservationReleases);
        }
        expect(getSessionMutationCount()).toBe(0);
        expect(getSessionControllerWorkCount()).toBe(0);
      },
    );
  });
}

test("measures natural descendant settlement in the session-list owner", async ({ signal }) => {
  const context = expectDefined(connectionObserver.context, "Gateway context");
  const socket = await gateway.openWs();
  const rootKey = "agent:main:main";
  const parentKey = "agent:main:subagent:ancestor-probe-parent";
  const leafKey = "agent:main:subagent:ancestor-probe-leaf";
  const storePath = path.join(
    process.env.OPENCLAW_STATE_DIR!,
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
  const leases: SessionEffectRef[] = [];
  const frames: GatewayEventFrame[] = [];
  const receive = (data: { toString(): string }) => {
    const frame = JSON.parse(data.toString()) as GatewayEventFrame;
    if (
      frame.type === "event" &&
      (frame.event === "sessions.changed" || frame.event === "session.message")
    ) {
      frames.push(frame);
    }
  };
  const listParams = {
    agentId: "main",
    limit: 500,
    includeGlobal: true,
    includeUnknown: true,
    includeDerivedTitles: false,
    includeLastMessage: false,
  };
  const readList = async () => {
    const response = await fixture.rpcReq<SessionsListResult>(socket, "sessions.list", listParams);
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    return expectDefined(response.payload, "session list");
  };
  const finish = async (runId: string, sessionKey: string, lease: SessionEffectRef) => {
    // Only a received frame proves that the asynchronous lifecycle listener published.
    const published = fixture.onceMessage(socket, (frame) => {
      const event = frame as GatewayEventFrame;
      const payload = event.payload as { sessionKey?: string; reason?: string } | undefined;
      return (
        event.type === "event" &&
        event.event === "sessions.changed" &&
        payload?.sessionKey === sessionKey &&
        payload.reason === "subagent-status"
      );
    });
    lease.release();
    emitAgentEvent({
      runId,
      sessionKey,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "Synthetic descendant completion." },
      },
    });
    await withinTest(published, signal);
    await flushPendingSessionsChangedEvents(context);
  };
  try {
    await fixture.connectOk(socket, {
      scopes: ["operator.read", "operator.write"],
      prePairDevice: true,
    });
    for (const [key, parentSessionKey, spawnDepth] of [
      [rootKey, undefined, undefined],
      [parentKey, rootKey, 1],
      [leafKey, parentKey, 2],
      ...Array.from({ length: 97 }, (_, i) => [
        `agent:main:ancestor-probe-filler-${i}`,
        undefined,
        undefined,
      ]),
    ] as const) {
      const response = await fixture.rpcReq(socket, "sessions.create", {
        key,
        agentId: "main",
        visibility: "shared",
        parentSessionKey,
        spawnDepth,
      });
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
    }
    const runs = [
      ["ancestor-probe-parent-run", parentKey, rootKey],
      ["ancestor-probe-leaf-run", leafKey, parentKey],
    ] as const;
    for (const [runId, key, requesterSessionKey] of runs) {
      const entry = expectDefined(
        sessions.loadExactSessionEntryReadOnly({ storePath, sessionKey: key })?.entry,
        "created session",
      );
      const lease = await beginSessionEffect({
        scope: storePath,
        identities: [key, entry.sessionId],
        resolveGatewayContext: context.resolveGatewayContext,
        run: { runId, sessionKey: key, sessionId: entry.sessionId, agentId: "main" },
        assertAllowed: () => {},
        onInterrupt: () => ({ runId }),
      });
      leases.push(lease);
      await registerSubagentRun({
        runId,
        childSessionKey: key,
        childAgentId: "main",
        sessionEntry: entry,
        requesterSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterSessionKey,
        ...(key === leafKey ? { requesterTurnRunId: runs[0][0] } : {}),
        gatewayContextResolver: context.resolveGatewayContext,
        task: "Synthetic descendant lifecycle",
        cleanup: "keep",
        collect: false,
        expectsCompletionMessage: false,
      });
    }
    expect((await fixture.rpcReq(socket, "sessions.subscribe", listParams)).ok).toBe(true);
    await finish(runs[0][0], parentKey, leases[0]!);
    const before = await readList();
    for (const key of [rootKey, parentKey]) {
      expect(before.sessions.find((row) => row.key === key)?.hasActiveSubagentRun).toBe(true);
    }
    expect(before.sessions.find((row) => row.key === parentKey)?.hasActiveRun).toBe(false);
    expect(before.sessions.find((row) => row.key === leafKey)?.hasActiveRun).toBe(true);
    socket.on("message", receive);
    await finish(runs[1][0], leafKey, leases[1]!);
    const after = await readList();
    for (const key of [rootKey, parentKey, leafKey]) {
      const row = expectDefined(
        after.sessions.find((candidate) => candidate.key === key),
        "settled session",
      );
      expect(row.hasActiveSubagentRun).not.toBe(true);
      expect(row.hasActiveRun).not.toBe(true);
    }
    expect(after.sessions.find((row) => row.key === leafKey)?.hasActiveRun).toBe(false);
    socket.off("message", receive);
    const terminal = frames.find((frame) => {
      const payload = frame.payload as { sessionKey?: string; reason?: string } | undefined;
      return (
        frame.event === "sessions.changed" &&
        payload?.sessionKey === leafKey &&
        payload.reason === "subagent-status"
      );
    });
    const ancestors =
      (terminal?.payload as { ancestorSessions?: SessionsListResult["sessions"] } | undefined)
        ?.ancestorSessions ?? [];
    expect(ancestors.find((row) => row.key === parentKey)?.hasActiveSubagentRun).toBe(false);
    expect(ancestors.some((row) => row.key === rootKey)).toBe(true);
    expect(ancestors.find((row) => row.key === rootKey)?.hasActiveSubagentRun).not.toBe(true);
    const measured: { wallMs: number; cpuMs: number }[] = [];
    const sortCounts: number[] = [];
    for (let sample = -1; sample < 7; sample += 1) {
      const client = createTestGatewayClient(async (method) => {
        if (method === "sessions.list") {
          return structuredClone(before);
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        throw new Error(`Unexpected diagnostic request: ${method}`);
      });
      const harness = createGatewayHarness(client);
      const owner = createTestSessionCapability(harness.gateway);
      try {
        await owner.refresh(listParams);
        expect(owner.state.result?.sessions.length).toBe(before.sessions.length);
        const nativeSort = Array.prototype.sort;
        let frameSorts = 0;
        const spy =
          sample === -1
            ? vi.spyOn(Array.prototype, "sort").mockImplementation(function (
                this: unknown[],
                compare,
              ) {
                if (this.length === before.sessions.length) {
                  frameSorts += 1;
                }
                return nativeSort.call(this, compare);
              })
            : undefined;
        const cpu = process.cpuUsage();
        const started = performance.now();
        try {
          for (const frame of frames) {
            const startCount = frameSorts;
            harness.emitEvent(frame);
            if (sample === -1) {
              sortCounts.push(frameSorts - startCount);
            }
          }
        } finally {
          spy?.mockRestore();
        }
        const wallMs = performance.now() - started;
        const used = process.cpuUsage(cpu);
        if (sample >= 0) {
          measured.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
        }
        for (const key of [rootKey, parentKey, leafKey]) {
          const actual = owner.state.result?.sessions.find((row) => row.key === key);
          const expected = after.sessions.find((row) => row.key === key);
          expect(actual?.hasActiveSubagentRun).toBe(expected?.hasActiveSubagentRun);
          expect(actual?.hasActiveRun).toBe(expected?.hasActiveRun);
        }
      } finally {
        owner.dispose();
      }
    }
    console.log(
      "SESSION_ANCESTOR_BASELINE",
      JSON.stringify({
        rows: before.sessions.length,
        frames: frames.length,
        ancestorCount: ancestors.length,
        sortCounts,
        firstTimedReplay: measured[0],
        processWarmFirstEventSamples: measured.slice(1),
        runtime: process.versions.bun ?? process.version,
      }),
    );
  } finally {
    socket.off("message", receive);
    for (const lease of leases) {
      lease.release();
    }
    socket.close();
  }
});
