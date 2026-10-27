import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { projectionOperations } from "../../gateway/worker-environments/local-workspace-state.js";
import type { LocalWorkspaceOwner } from "../../gateway/worker-environments/local-workspace-types.js";
import * as backoff from "../../infra/backoff.js";
import type { DiagnosticPhaseSnapshot } from "../../infra/diagnostic-events.js";
import * as allocation from "../worktrees/allocation.js";
import {
  createWorktreeCapacityStatfs,
  useInProcessWorktreeCapacityTransport,
} from "../worktrees/capacity.test-support.js";
import { withWorktreePreparationTiming } from "../worktrees/preparation-timing.js";
import { useWorktreeStateRoots } from "../worktrees/state-fixture.test-support.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { prepareLocalSandboxWorkspace } from "./local-workspace.js";

type Projection = Pick<ReturnType<typeof projectionOperations>, "reuse" | "prepare">;
const fixture = vi.hoisted(() => {
  const release = vi.fn();
  const owner: LocalWorkspaceOwner & Disposable = {
    agentId: "main",
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    lifecycleRevision: null,
    assertCurrent: () => {},
    [Symbol.dispose]: release,
    worktree: {
      id: "fixture-worktree",
      name: "fixture",
      repoFingerprint: "fixture-repository",
      repoRoot: "/repository",
      path: "/managed/fixture",
      branch: "openclaw/fixture",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:fixture",
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  return {
    owner,
    owners: new Map<string, LocalWorkspaceOwner & Disposable>(),
    release,
    reuse: vi.fn<Projection["reuse"]>(),
    prepare:
      vi.fn<
        (
          owner: LocalWorkspaceOwner,
          ...args: Parameters<Projection["prepare"]>
        ) => ReturnType<Projection["prepare"]>
      >(),
    event: vi.fn<(event: DiagnosticPhaseSnapshot) => void>(),
    log: vi.fn<(message: string, metadata: Record<string, unknown>) => void>(),
  };
});

// mock-isolation: Real lease/capacity ownership surrounds a gated checkout instead of native Git.
vi.mock("../../gateway/worker-environments/local-workspace-projection.js", () => ({
  resolveLocalWorkspaceOwner: ({ sessionKey }: { sessionKey: string }) =>
    fixture.owners.get(sessionKey) ?? fixture.owner,
  withLocalWorkspaceProjection: async <T>(
    owner: LocalWorkspaceOwner,
    run: (state: Projection) => Promise<T>,
  ) => run({ reuse: fixture.reuse, prepare: (...args) => fixture.prepare(owner, ...args) }),
}));
// mock-isolation: Retain the real timing owner while observing its output without global queues.
vi.mock("../../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/diagnostic-events.js")>()),
  createQueuedDiagnosticPhaseEmitter: () => fixture.event,
}));
// mock-isolation: Capture journal metadata without writing host logs.
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({
    info: fixture.log,
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const roots = useWorktreeStateRoots();
beforeEach(() => {
  fixture.owners.clear();
  fixture.reuse.mockReset().mockResolvedValue(undefined);
  fixture.prepare.mockReset();
});
afterEach(() => vi.clearAllMocks());

it.each([
  { name: "an existing projection", existing: "/projection/fixture", acceleration: true },
  { name: "disabled acceleration", existing: undefined, acceleration: false },
])("omits allocation timing for $name", async ({ existing, acceleration }) => {
  const allocate = vi.spyOn(allocation, "withWorktreeAllocationLease");
  const mutate = vi.spyOn(allocation, "withWorktreeMutationLease");
  fixture.reuse.mockResolvedValue(existing);
  fixture.prepare.mockResolvedValue("/projection/fixture");
  const cfg: OpenClawConfig = { worktreeAcceleration: acceleration };
  using workspace = await withWorktreePreparationTiming("sandbox", () =>
    prepareLocalSandboxWorkspace({
      cfg,
      agentId: fixture.owner.agentId,
      sessionKey: fixture.owner.sessionKey,
      workspaceDir: "/managed/fixture/src",
      sandbox: resolveSandboxConfigForAgent(cfg, fixture.owner.agentId),
    }),
  );
  expect(workspace).toMatchObject({
    workspaceDir: "/projection/fixture",
    workspaceCwd: path.join("/projection/fixture", "src"),
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect(fixture.event).toHaveBeenCalledTimes(1);
  expect(fixture.event.mock.calls[0]?.[0].details).not.toHaveProperty("allocate");
  expect(fixture.log).toHaveBeenCalledTimes(1);
  expect(fixture.log.mock.calls[0]?.[1].phaseDurationsMs).not.toHaveProperty("allocate");
});

function coldWorkspace(id: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const owner: LocalWorkspaceOwner & Disposable = {
    ...fixture.owner,
    sessionKey: `agent:main:${id}`,
    sessionId: id,
    worktree: { ...fixture.owner.worktree, id },
    env,
  };
  fixture.owners.set(owner.sessionKey, owner);
  const cfg: OpenClawConfig = {};
  return () =>
    prepareLocalSandboxWorkspace({
      cfg,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      sandbox: resolveSandboxConfigForAgent(cfg, owner.agentId),
      signal,
    });
}

async function settleWorkspaces(pending: Array<ReturnType<typeof prepareLocalSandboxWorkspace>>) {
  for (const result of await Promise.allSettled(pending)) {
    if (result.status === "fulfilled") {
      result.value?.[Symbol.dispose]();
    }
  }
}

it("prepares distinct cold projections together while unrelated slot allocation is held", async ({
  signal,
}) => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: roots.make("sandbox-allocation-overlap-") };
  const allocated = createDeferred();
  const releaseAllocation = createDeferred();
  const releasePreparation = createDeferred();
  const entered = new Set<string>();
  const bothEntered = createDeferred();
  fixture.prepare.mockImplementation(async (owner) => {
    entered.add(owner.worktree.id);
    if (entered.size === 2) {
      bothEntered.resolve();
    }
    await releasePreparation.promise;
    return `/projection/${owner.worktree.id}`;
  });
  const holder = allocation.withWorktreeAllocationLease({ env, signal }, async () => {
    allocated.resolve();
    await releaseAllocation.promise;
  });
  const pending: Array<ReturnType<typeof prepareLocalSandboxWorkspace>> = [];
  try {
    await withinTest(
      awaitGateBeforeSettlement(allocated.promise, holder, "slot allocation failed"),
      signal,
    );
    pending.push(coldWorkspace("first", env, signal)(), coldWorkspace("second", env, signal)());
    await withinTest(
      awaitGateBeforeSettlement(
        bothEntered.promise,
        Promise.all(pending),
        "projections did not overlap",
      ),
      signal,
    );
    expect(entered).toEqual(new Set(["first", "second"]));
    releasePreparation.resolve();
    expect((await Promise.all(pending)).map((workspace) => workspace?.workspaceDir)).toEqual([
      "/projection/first",
      "/projection/second",
    ]);
  } finally {
    releaseAllocation.resolve();
    releasePreparation.resolve();
    await Promise.allSettled([holder]);
    await settleWorkspaces(pending);
  }
});

it("waits for the same worktree's mutation custody before preparing its projection", async ({
  signal,
}) => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: roots.make("sandbox-mutation-wait-") };
  const entered = createDeferred();
  const release = createDeferred();
  const contended = createDeferred();
  fixture.prepare.mockResolvedValue("/projection/same");
  const holder = allocation.withWorktreeMutationLease({ env, id: "same", signal }, async () => {
    entered.resolve();
    await release.promise;
  });
  let preparing: ReturnType<typeof prepareLocalSandboxWorkspace> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, holder, "mutation custody failed"),
      signal,
    );
    const sleep = backoff.sleepWithAbort;
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (...args) => {
      contended.resolve();
      await sleep(...args);
    });
    preparing = coldWorkspace("same", env, signal)();
    await withinTest(
      awaitGateBeforeSettlement(
        contended.promise,
        preparing,
        "same checkout preparation bypassed mutation custody",
      ),
      signal,
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
    release.resolve();
    expect((await preparing)?.workspaceDir).toBe("/projection/same");
  } finally {
    release.resolve();
    await Promise.allSettled([holder]);
    await settleWorkspaces(preparing ? [preparing] : []);
  }
});

it.for([false, true])(
  "releases checkout custody during disk contention (cancel=%s)",
  async (cancel, { signal }) => {
    useInProcessWorktreeCapacityTransport();
    const root = roots.make("sandbox-capacity-wait-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const GiB = 1024 ** 3;
    vi.spyOn(fs, "statfsSync").mockReturnValue(
      createWorktreeCapacityStatfs(fs.statfsSync(root), 6 * GiB),
    );
    const caller = new AbortController();
    const current = AbortSignal.any([signal, caller.signal]);
    const reserved = createDeferred();
    const release = createDeferred();
    const waiting = createDeferred();
    const wait = allocation.waitForWorktreeCapacity;
    vi.spyOn(allocation, "waitForWorktreeCapacity").mockImplementation((...args) => {
      waiting.resolve();
      return wait(...args);
    });
    fixture.prepare.mockImplementation(async (_owner, dependencies) => {
      if (!dependencies) {
        throw new Error("cold projection requires disk admission");
      }
      await dependencies.allocation.requireDiskSpace([{ path: root, bytes: GiB }], "projection");
      return "/projection/waiter";
    });
    const holder = allocation.withWorktreeMutationLease(
      { env, id: "disk-holder", signal },
      async (guard) => {
        await guard.requireDiskSpace([{ path: root, bytes: 3 * GiB }], "holder", true);
        reserved.resolve();
        await release.promise;
      },
    );
    let preparing: ReturnType<typeof prepareLocalSandboxWorkspace> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(reserved.promise, holder, "disk reservation failed"),
        signal,
      );
      preparing = coldWorkspace("waiter", env, current)();
      await withinTest(
        awaitGateBeforeSettlement(waiting.promise, preparing, "disk contention did not wait"),
        signal,
      );
      // The waiter must release checkout custody so cleanup can make space for its retry.
      await withinTest(
        allocation.withWorktreeMutationLease({ env, id: "waiter", signal }, async () => {}),
        signal,
      );
      if (cancel) {
        caller.abort(new Error("cancel capacity waiter"));
        await expect(preparing).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
        expect(fixture.prepare).toHaveBeenCalledTimes(1);
      } else {
        release.resolve();
        expect((await preparing)?.workspaceDir).toBe("/projection/waiter");
        expect(fixture.prepare).toHaveBeenCalledTimes(2);
      }
    } finally {
      release.resolve();
      caller.abort();
      await Promise.allSettled([holder]);
      await settleWorkspaces(preparing ? [preparing] : []);
    }
  },
);
