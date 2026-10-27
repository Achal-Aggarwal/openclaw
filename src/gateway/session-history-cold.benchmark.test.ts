import { channel } from "node:diagnostics_channel";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionColdBatchInWorker } from "../config/sessions/session-cold-storage-prepare.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import type { SessionColdReadPreparation } from "../config/sessions/session-cold-storage-read.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { mutateSessionColdTranscriptInWorker } from "../config/sessions/session-cold-storage-worker.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedHistoryTranscript } from "./server-methods/chat-history-fixture.test-support.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "./server-methods/types.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";
import { readSessionMessagesMatchingIdAsync } from "./session-transcript-readers.js";

it.runIf(process.env.OPENCLAW_HISTORY_COLD_BENCH === "1")(
  "measures cold chat.history and repeated exact message lookup caller CPU",
  () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cold-bench",
        sessionId: "cold-bench",
        storePath: database.path,
      };
      const rows = 5_000;
      const entry = { sessionId: scope.sessionId, updatedAt: 1, visibility: "shared" as const };
      const report = (metrics: Record<string, unknown>) => console.log(JSON.stringify(metrics));
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...Array.from({ length: rows }, (_, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          message: { role: "assistant", content: `Synthetic ${index} ${"x".repeat(1_024)}` },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const context = await createHistoryReadContext();
      const client = identifiedClient("history-benchmark");
      const history = async (): Promise<unknown[]> => {
        let response: Parameters<RespondFn> | undefined;
        await chatHistoryHandlers["chat.history"]!({
          params: { sessionKey: scope.sessionKey, limit: 20 },
          context,
          client,
          req: { type: "req", id: "cold-bench", method: "chat.history" },
          isWebchatConnect: () => false,
          respond: (...args) => {
            response = args;
          },
        });
        expect(response?.[0]).toBe(true);
        const payload = asOptionalRecord(response?.[1]);
        if (!Array.isArray(payload?.messages)) {
          throw new Error("Expected history messages");
        }
        return payload.messages;
      };
      const golden = await history();
      await replaceSessionEntry(scope, { ...entry, lastActivityAt: 1, lastInteractionAt: 1 });
      database.db.exec("UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1");
      expect(
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(database.path) }),
      ).toMatchObject({ archivedTranscripts: 1 });
      expect(readSessionColdTranscript(database.db, scope.sessionId)).toBeDefined();
      const coldStart = performance.now();
      const coldCpu = process.threadCpuUsage();
      const restored = await history();
      const coldElapsed = process.threadCpuUsage(coldCpu);
      report({
        method: "chat.history",
        rows,
        cold: true,
        cpuMs: (coldElapsed.user + coldElapsed.system) / 1_000,
        wallMs: performance.now() - coldStart,
      });
      expect(restored).toEqual(golden);
      const lookup = () => readSessionMessagesMatchingIdAsync(scope, "message-4999");
      const expected = await lookup();
      expect(expected).toHaveLength(1);
      // The original acquisition composition, sharing the unchanged lookup kernel.
      const localReader = createSessionTranscriptReader({
        resolveTarget: resolveTranscriptReadTarget,
        readSnapshot: async (target, read, options) => {
          const bound = toTranscriptReadScope(target);
          return readRestoredSessionTranscript(
            bound,
            () => withCurrentProjectionSnapshot(bound, read, options),
            options,
          );
        },
      });
      for (const [mode, read] of [
        ["caller", () => localReader.readSessionMessagesMatchingIdAsync(scope, "message-4999")],
        ["worker", lookup],
      ] as const) {
        const samples = [];
        for (let round = 0; round < 7; round++) {
          const start = performance.now();
          const cpu = process.threadCpuUsage();
          for (let call = 0; call < 10; call++) {
            expect(await read()).toEqual(expected);
          }
          const elapsed = process.threadCpuUsage(cpu);
          if (round >= 2) {
            samples.push({
              cpuMs: (elapsed.user + elapsed.system) / 10_000,
              wallMs: (performance.now() - start) / 10,
            });
          }
        }
        report({
          method: "message-lookup",
          mode,
          rows,
          samples,
          medianCpuMs: samples.map((s) => s.cpuMs).toSorted((a, b) => a - b)[2],
          medianWallMs: samples.map((s) => s.wallMs).toSorted((a, b) => a - b)[2],
        });
      }
    }),
);

/**
 * OPENCLAW_VITEST_RUNTIME=node OPENCLAW_RESTORE_COALESCE_BENCH=1 node scripts/run-vitest.mjs \
 *   src/gateway/session-history-cold.benchmark.test.ts --maxWorkers=1
 * One warm-up pair, then five counterbalanced pairs of 64 restores of one 512-event
 * cold transcript, synchronized after their native metadata reads. BASE_MODULE names
 * a saved baseline session-cold-storage
 * module with relative imports intact; prefix it with OPENCLAW_RESTORE_COALESCE_.
 * ALLOCATION=1 with that prefix runs a separate main-isolate sampling pass including
 * collected objects through Node's V8 sampler. Use Node for both timing and allocation.
 * Process CPU includes native workers; main CPU/allocation do not.
 * Real metadata worker and restoration owners; this is not WebSocket/Gateway stress.
 */
it.runIf(process.env.OPENCLAW_RESTORE_COALESCE_BENCH === "1")(
  "measures concurrent cold restores through the native metadata and mutation owners",
  () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const basePath = process.env.OPENCLAW_RESTORE_COALESCE_BASE_MODULE;
      const baseline:
        | { restoreSessionColdTranscript: typeof restoreSessionColdTranscript }
        | undefined = basePath ? await import(basePath) : undefined;
      const fixture = await createSessionColdStorageFixture(
        path.join(state.agentDir(), "openclaw-agent.sqlite"),
      );
      const rows = 512;
      const calls = 64;
      await seedHistoryTranscript(
        fixture.scope,
        Array.from({ length: rows }, (_, i) => [
          `coalescing-benchmark-${i}`,
          { role: i % 2 ? "assistant" : "user", content: `${i} ${"payload ".repeat(128)}` },
        ]),
      );
      await waitForSessionTranscriptProjection(fixture.scope);
      fixture
        .database()
        .prepare(
          "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
        )
        .run(historicalId);
      const original = fixture.snapshot();
      const sampling = process.env.OPENCLAW_RESTORE_COALESCE_ALLOCATION === "1";
      const inspector = sampling ? new Session() : undefined;
      inspector?.connect();
      const env = { OPENCLAW_STATE_DIR: state.stateDir };
      try {
        await withSessionHistoryWorkerDatabase(
          fixture.options,
          async (reader) => {
            // Warm the retained metadata owner outside every measured arm.
            await reader.readColdMetadata({ sessionId: historicalId, env });
            for (let pair = -1; pair < 5; pair++) {
              const arms = baseline
                ? pair % 2
                  ? ([
                      ["candidate", restoreSessionColdTranscript],
                      ["base", baseline.restoreSessionColdTranscript],
                    ] as const)
                  : ([
                      ["base", baseline.restoreSessionColdTranscript],
                      ["candidate", restoreSessionColdTranscript],
                    ] as const)
                : ([["candidate", restoreSessionColdTranscript]] as const);
              for (const [arm, restore] of arms) {
                const batch = await prepareSessionColdBatchInWorker({
                  databaseOptions: fixture.options,
                  admissionIdentities: [],
                  liveSessionKeys: [],
                  cooledSessionIds: [],
                  beforeMs: 100,
                  maxTranscripts: 1,
                  maxBytes: 64 * 1024 * 1024,
                });
                expect(
                  mutateSessionColdTranscriptInWorker(
                    {
                      kind: "cold-batch",
                      databaseOptions: fixture.options,
                      prepared: batch.prepared,
                      externalizations: batch.externalizations,
                      protectionKeys: batch.protectionKeys,
                      beforeMs: 100,
                      liveSessionKeys: [],
                    },
                    undefined,
                    () => {},
                  ).archivedTranscripts,
                ).toBe(1);
                const metadataCalls = { initial: 0, queued: 0 };
                const initialReady = Promise.withResolvers<void>();
                let initialCompleted = 0;
                const preparation: SessionColdReadPreparation = {
                  target: {
                    agentId: "main",
                    path: fixture.scope.storePath,
                    sessionId: historicalId,
                    env,
                  },
                  readMetadata: async (phase) => {
                    metadataCalls[phase]++;
                    const { archive } = await reader.readColdMetadata({
                      sessionId: historicalId,
                      env,
                    });
                    if (phase === "initial") {
                      if (++initialCompleted === calls) {
                        initialReady.resolve();
                      }
                      await initialReady.promise;
                    }
                    return archive;
                  },
                };
                if (sampling) {
                  await inspector!.post("HeapProfiler.startSampling", {
                    samplingInterval: 4096,
                    includeObjectsCollectedByMajorGC: true,
                    includeObjectsCollectedByMinorGC: true,
                  });
                }
                const memoryBefore = process.memoryUsage();
                let restoreCommits = 0;
                const diagnostics = channel("openclaw.session.write");
                const observe = (message: unknown) => {
                  if (
                    asOptionalRecord(message)?.operation === "session.reclamation.worker-commit"
                  ) {
                    restoreCommits++;
                  }
                };
                diagnostics.subscribe(observe);
                const cpu = process.cpuUsage();
                const mainCpu = process.threadCpuUsage();
                const started = performance.now();
                try {
                  await Promise.all(
                    Array.from({ length: calls }, () =>
                      restore(fixture.scope, () => reader.assertCurrent(), preparation),
                    ),
                  );
                } finally {
                  diagnostics.unsubscribe(observe);
                }
                const wallMs = performance.now() - started;
                const elapsed = process.cpuUsage(cpu);
                const mainElapsed = process.threadCpuUsage(mainCpu);
                let mainAllocatedBytes: number | undefined;
                if (sampling) {
                  const { profile } = await inspector!.post("HeapProfiler.stopSampling");
                  const sum = (node: typeof profile.head): number =>
                    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
                  mainAllocatedBytes = sum(profile.head);
                }
                if (pair >= 0) {
                  console.log(
                    JSON.stringify({
                      benchmark: "cold-restore-coalescing",
                      arm,
                      pair,
                      rows,
                      calls,
                      sampling,
                      metadataCalls,
                      restoreCommits,
                      wallMs,
                      cpuMs: (elapsed.user + elapsed.system) / 1_000,
                      mainCpuMs: (mainElapsed.user + mainElapsed.system) / 1_000,
                      mainAllocatedBytes,
                      memoryBefore,
                      memoryAfter: process.memoryUsage(),
                      hostLoad: loadavg(),
                    }),
                  );
                }
                expect(metadataCalls).toEqual({
                  initial: calls,
                  queued: arm === "base" ? calls : 1,
                });
                expect(restoreCommits).toBe(1);
                expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
                expect(fixture.snapshot()).toEqual(original);
              }
            }
          },
          projectionLane,
        );
      } finally {
        inspector?.disconnect();
      }
    }),
  180_000,
);
