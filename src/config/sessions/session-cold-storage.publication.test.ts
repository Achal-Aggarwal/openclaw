import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { runSqliteTranscriptArchiveWorkerOperation as ArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { withSqliteReclamationAuthorization as ReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import type { runExclusiveSqliteSessionWrite as ExclusiveWrite } from "./session-accessor.sqlite-scope.js";
import type { withSqliteMutationWorkerLifetime as WorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import type { SessionColdReadPreparation } from "./session-cold-storage-read.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";

type Receipt = { result: SessionColdMutationResult; cleanupIncomplete?: boolean };
const observed = vi.hoisted(() => ({
  worker: vi.fn<(params: Parameters<typeof ArchiveWorker>[0]) => Promise<Receipt[]>>(),
  admit: vi.fn<(signal?: AbortSignal) => void | Promise<void>>(),
  native: vi.fn(),
  caller: vi.fn(),
  request: vi.fn(),
  release: vi.fn(),
  claimCurrent: true,
}));

vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: observed.native,
  retainOpenClawAgentDatabaseReadOnly: (options: OpenClawAgentDatabaseOptions) => ({
    found: true,
    database: { path: options.path, db: { prepare: observed.native } },
    claim: {
      assertCurrent() {
        if (!observed.claimCurrent) {
          throw new Error("database owner retired");
        }
      },
      isCurrent: () => observed.claimCurrent,
      release: observed.release,
    },
  }),
}));
// mock-isolation: exercise restoration admission and publication without native SQLite.
vi.mock("./session-accessor.sqlite-scope.js", async () => ({
  toDatabaseOptions: (await import("./session-accessor.sqlite-scope-helpers.js")).toDatabaseOptions,
  prepareSqliteTranscriptReadScope: vi.fn(),
  resolveSqliteTranscriptReadScope: vi.fn(),
  runExclusiveSqliteSessionWrite: (async (
    _options,
    run,
    _operation,
    _diagnostics,
    _writer,
    signal,
  ) => {
    await observed.admit(signal);
    return await run();
  }) satisfies typeof ExclusiveWrite,
}));
// mock-isolation: exercise receipt handling without native lifecycle resources.
vi.mock("./session-accessor.sqlite-worker-request.js", () => ({
  withSqliteMutationWorkerLifetime: (async (_options, run, callerSignal) =>
    await run({
      assertCurrent: observed.request,
      commitGate: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      signal: callerSignal ?? new AbortController().signal,
    })) satisfies typeof WorkerLifetime,
}));
vi.mock("./session-accessor.sqlite-reclamation-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-reclamation-commit.js")>()),
  withSqliteReclamationAuthorization: (async (_gate, _database, assertCurrent, run) =>
    await run(assertCurrent)) satisfies typeof ReclamationAuthorization,
}));
vi.mock("./session-accessor.sqlite-archive.js", () => ({
  runSqliteTranscriptArchiveWorkerOperation: observed.worker,
}));
vi.mock("../../state/openclaw-agent-db.js", async () => ({
  resolveOpenClawAgentSqlitePath: (await import("../../state/openclaw-agent-db.paths.js"))
    .resolveOpenClawAgentSqlitePath,
}));

vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadWorkerContext: vi.fn(),
}));
vi.mock("./session-accessor.sqlite-page-reclamation.js", () => ({
  withSqliteSessionPageReclamation: vi.fn(),
}));
vi.mock("./session-history-archive-pruning.js", () => ({ reclaimSqliteFreePages: vi.fn() }));
vi.mock("./session-history-eviction.js", () => ({ collectAdmissionProtectedSessionIds: vi.fn() }));

vi.mock("./session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: vi.fn(),
}));
vi.mock("./targets.js", () => ({
  resolveSessionStoreTargets: vi.fn(),
}));

const preparation: SessionColdReadPreparation = {
  target: {
    agentId: "main",
    sessionId: "archived-transcript",
    path: "/synthetic/cold-publication.sqlite",
    env: { OPENCLAW_STATE_DIR: "/synthetic/cold-publication" },
  },
  readMetadata: async () => ({
    session_id: "archived-transcript",
    generation: "archived-generation",
    archive_name: "archive.jsonl.zst",
    archive_sha256: "0".repeat(64),
    event_count: 1,
    raw_bytes: 100,
    archive_bytes: 80,
    last_seq: 1,
    archived_at: 1,
    storage: "file",
  }),
};
const result: SessionColdMutationResult = {
  archivedTranscripts: 0,
  externalizedTranscripts: 0,
  restored: true,
  sessionKey: "agent:main:committed-window",
};
const changes = vi.fn();
const factChanges = vi.fn();
let subscriptions: (() => void)[];
let expectedReleases: number;

beforeEach(() => {
  vi.resetAllMocks();
  expectedReleases = 1;
  observed.claimCurrent = true;
  observed.native.mockImplementation(() => {
    throw new Error("Restore publication executed SQLite on the calling thread");
  });
  subscriptions = [sessionChanges.subscribe(changes), sessionChanges.subscribeFacts(factChanges)];
});
afterEach(() => {
  subscriptions.forEach((unsubscribe) => unsubscribe());
  expect(observed.native).not.toHaveBeenCalled();
  expect(observed.release).toHaveBeenCalledTimes(expectedReleases);
});

function restore(signal?: AbortSignal) {
  return restoreSessionColdTranscript(
    preparation.target,
    observed.caller,
    preparation,
    undefined,
    signal,
  );
}

function holdWorker() {
  const entered = createDeferred();
  const finished = createDeferred<Receipt[]>();
  observed.worker.mockImplementation(() => {
    entered.resolve();
    return finished.promise;
  });
  return { entered, finished };
}

it("cancels restoration queued at writer admission when its host callback expires", async () => {
  const controller = new AbortController();
  const queued = createDeferred();
  const entered = createDeferred<AbortSignal | undefined>();
  observed.admit
    .mockImplementationOnce(() => {})
    .mockImplementationOnce((signal) => {
      entered.resolve(signal);
      signal?.addEventListener("abort", () => queued.reject(signal.reason), { once: true });
      return queued.promise;
    });
  observed.worker.mockImplementation(async (params) => {
    if (params.expectedMessageType !== "reclaimed") {
      throw new Error("Expected cold restoration worker");
    }
    await params.withWriteAdmission(
      async () => undefined,
      { admissionId: 1 },
      { settled: Promise.resolve({ kind: "completed" }) },
    );
    return [{ result }];
  });
  const pending = restore(controller.signal);
  const outcome = Promise.allSettled([pending]);
  try {
    const signal = await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "Restore did not reach writer admission",
    );
    expect(signal).toBeDefined();
    const expired = new Error("usage restore callback deadline expired");
    controller.abort(expired);
    expect(signal?.aborted).toBe(true);
    expect(await outcome).toEqual([{ status: "rejected", reason: expired }]);
  } finally {
    queued.resolve();
    await outcome;
  }
});

it.for(["abort", "authority"])(
  "refuses a joined caller after %s without canceling its owner",
  async (failure, { signal }) => {
    const { entered, finished } = holdWorker();
    const first = restore();
    await awaitGateBeforeSettlement(entered.promise, first, "First restore was not admitted");
    const controller = new AbortController();
    const caller = vi.fn();
    const second = restoreSessionColdTranscript(
      preparation.target,
      caller,
      preparation,
      undefined,
      controller.signal,
    );
    const outcome = Promise.allSettled([second]);
    const refused = new Error("joined reader retired");
    try {
      await Promise.resolve();
      if (failure === "abort") {
        controller.abort(refused);
        await withinTest(outcome, signal);
        expect(observed.release).not.toHaveBeenCalled();
      } else {
        caller.mockImplementation(() => {
          throw refused;
        });
      }
    } finally {
      finished.resolve([{ result }]);
      await Promise.allSettled([first, second]);
    }
    await expect(first).resolves.toBeUndefined();
    expect(await outcome).toEqual([{ status: "rejected", reason: refused }]);
    expect(observed.worker).toHaveBeenCalledOnce();
  },
);

it("shares one restoration and publishes exact receipts once after concurrent opens settle", async () => {
  const { entered, finished } = holdWorker();
  let cold = true;
  const readMetadata = vi.fn(async () => (cold ? preparation.readMetadata("initial") : undefined));
  const open = () =>
    restoreSessionColdTranscript(preparation.target, observed.caller, {
      ...preparation,
      readMetadata,
    });
  const first = open();
  await awaitGateBeforeSettlement(entered.promise, first, "Restore worker was not dispatched");
  const followers = Array.from({ length: 7 }, open);
  try {
    // Each caller captures its own initial archive identity before joining.
    await Promise.resolve();
    expect(changes).not.toHaveBeenCalled();
    expect(observed.release).not.toHaveBeenCalled();
    cold = false;
  } finally {
    finished.resolve([{ result }]);
    await Promise.all([first, ...followers]);
  }
  expect(observed.worker).toHaveBeenCalledOnce();
  expect(readMetadata).toHaveBeenCalledTimes(9);
  const change = {
    storePath: preparation.target.path,
    sessionKey: "agent:main:committed-window",
    scope: "transcript",
  };
  expect(changes).toHaveBeenCalledExactlyOnceWith(change);
  expect(factChanges).toHaveBeenCalledExactlyOnceWith({ ...change, facts: { kind: "unchanged" } });
});

it.each(["generation", "digest", "guard"])(
  "does not join a restoration with a different %s",
  async (difference) => {
    expectedReleases = 2;
    const { entered, finished } = holdWorker();
    const first = restore();
    await awaitGateBeforeSettlement(entered.promise, first, "Restore worker was not dispatched");
    const archive = (await preparation.readMetadata("initial"))!;
    const second = restoreSessionColdTranscript(
      preparation.target,
      observed.caller,
      {
        ...preparation,
        readMetadata: async () => ({
          ...archive,
          ...(difference === "generation" ? { generation: "successor-generation" } : {}),
          ...(difference === "digest" ? { archive_sha256: "1".repeat(64) } : {}),
        }),
      },
      difference === "guard"
        ? {
            kind: "turn",
            agentId: "main",
            sessionKey: "agent:main:committed-window",
            options: { expectedSessionId: preparation.target.sessionId },
          }
        : undefined,
    );
    await Promise.resolve();
    finished.resolve([{ result }]);
    await Promise.all([first, second]);
    expect(observed.worker).toHaveBeenCalledTimes(2);
  },
);

it("evicts a failed shared restoration so a later open can retry", async () => {
  const { entered, finished } = holdWorker();
  const first = restore();
  await awaitGateBeforeSettlement(entered.promise, first, "Restore worker was not dispatched");
  const second = restore();
  const outcome = Promise.allSettled([first, second]);
  const failure = new Error("archive unavailable");
  await Promise.resolve();
  finished.reject(failure);
  expect(await outcome).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  expect(observed.worker).toHaveBeenCalledOnce();
  expect(observed.release).toHaveBeenCalledOnce();
  expectedReleases = 2;
  observed.worker.mockResolvedValue([{ result }]);
  await expect(restore()).resolves.toBeUndefined();
  expect(observed.worker).toHaveBeenCalledTimes(2);
});

it.each(["cleanup incomplete", "database", "caller", "request"])(
  "does not publish after restoration loses completion or authority: %s",
  async (outcome) => {
    observed.worker.mockImplementation(async () => {
      if (outcome === "database") {
        observed.claimCurrent = false;
      } else if (outcome === "caller" || outcome === "request") {
        observed[outcome].mockImplementation(() => {
          throw new Error("restore authority retired");
        });
      }
      return [{ result, ...(outcome === "cleanup incomplete" ? { cleanupIncomplete: true } : {}) }];
    });
    if (outcome === "database") {
      await restore();
    } else {
      await expect(restore()).rejects.toThrow(
        outcome === "cleanup incomplete" ? /cleanup is incomplete/ : "restore authority retired",
      );
    }
    expect(changes).not.toHaveBeenCalled();
  },
);
