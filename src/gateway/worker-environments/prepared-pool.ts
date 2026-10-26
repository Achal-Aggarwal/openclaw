import { randomUUID } from "node:crypto";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import {
  readWorkerPreparation,
  workerPreparationSourceKey,
} from "./preparation-identity.schema.js";
import * as pool from "./prepared-pool-admission.js";
import {
  createPreparedPoolPresence,
  isSupersededPresenceReserve,
  matchingPreparedPoolPresenceDemand,
} from "./prepared-pool-presence.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { readWorkerProfileSelection } from "./service-validation.js";
import type { WorkerEnvironmentRecord as Environment } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

const PREPARATION_CONCURRENCY = 2;
type Retained = { cleanup: Environment[]; work: Environment[]; cleaned: Set<string> };
type Reconciled = ReturnType<typeof runTasksWithConcurrency<void>>;
function reconcileAll(
  ctx: pool.PassContext,
  eligible: pool.Generations,
  records: Environment[],
): Reconciled {
  return runTasksWithConcurrency({
    tasks: records.map((record) => async () => {
      const { options } = ctx;
      const { store, signal } = options;
      signal.throwIfAborted();
      const key = pool.groupKey(record);
      const generation = key ? eligible.get(key) : undefined;
      const limits = pool.poolPolicy(options, record.profileId, record.providerId);
      const before = () => {
        signal.throwIfAborted();
        if (record.destroyRequestedAtMs === null && generation) {
          if (generation.deferred) {
            throw new Error("Prepared worker maintenance is deferred");
          }
          pool.assertGenerationCurrent(ctx, generation);
          if (
            !store.isPreparedIntentWithinCapacity({
              environmentId: record.environmentId,
              ...limits,
            })
          ) {
            throw new Error("Prepared worker no longer satisfies its maintenance policy");
          }
        }
      };
      const latest = store.get(record.environmentId);
      if (latest?.preparation?.consumedAtMs === null) {
        const controller = new AbortController();
        ctx.preparations.set(record.environmentId, controller);
        try {
          await options.reconcile(latest, AbortSignal.any([signal, controller.signal]), before);
        } finally {
          ctx.preparations.delete(record.environmentId);
        }
      }
    }),
    limit: PREPARATION_CONCURRENCY,
    onTaskError: () => {
      if (!ctx.options.signal.aborted) {
        ctx.options.warn(
          "Prepared worker maintenance failed; inspect the recorded environment failure and cleanup state",
        );
      }
    },
  });
}
async function retain(
  ctx: pool.PassContext,
  eligible: pool.Generations,
  cleaned: Set<string>,
  requireRetention: boolean,
): Promise<Retained> {
  const { options } = ctx;
  const { store, now } = options;
  const kept = new Map<string, number>();
  let totalKept = 0;
  const cleanup: Environment[] = [];
  const work: Environment[] = [];
  // Builds admitted during an await belong to the next scheduled pass's
  // source snapshot. Existing rows still use live promotion and cleanup state.
  for (const snapshot of ctx.oldestFirst) {
    const record = store.get(snapshot.environmentId);
    if (
      !record ||
      record.preparation?.consumedAtMs !== null ||
      record.state === "destroyed" ||
      record.state === "failed"
    ) {
      continue;
    }
    options.signal.throwIfAborted();
    const key = pool.groupKey(record);
    const generation = key ? eligible.get(key) : undefined;
    const limits = pool.poolPolicy(options, record.profileId, record.providerId);
    const count = key ? (kept.get(key) ?? 0) : 0;
    const expired =
      record.preparation.expiresAtMs <= now() ||
      (generation !== undefined && generation.expiresAtMs <= now());
    const valid =
      !isSupersededPresenceReserve(record, ctx.activeDemand) &&
      !expired &&
      generation?.preparation.key === record.preparation.key &&
      (!requireRetention || generation.retention !== undefined || generation.deferred) &&
      ((record.preparation.purpose === "build" && record.state !== "ready") ||
        count < limits.target) &&
      totalKept < limits.maxTotal;
    if (record.destroyRequestedAtMs === null && !valid) {
      await pool.retirePoolRecord(options, record, expired ? "expired" : "invalidated");
    } else if (record.destroyRequestedAtMs === null && key) {
      kept.set(key, count + 1);
      totalKept += 1;
    }
    const latest = store.get(record.environmentId)!;
    if (latest.destroyRequestedAtMs !== null) {
      if (!cleaned.has(record.environmentId)) {
        cleaned.add(record.environmentId);
        cleanup.push(latest);
      }
    } else if (
      !generation?.deferred &&
      (!generation?.presenceOwned || generation.activationEligible || ctx.presence.isPresent())
    ) {
      work.push(latest);
    }
  }
  return { cleanup, work, cleaned };
}
async function planRefill(
  ctx: pool.PassContext,
  eligible: pool.Generations,
): Promise<pool.Generations> {
  const { options, presence, activeDemand: demand, presenceDeferred: deferred } = ctx;
  const { store, signal, now } = options;
  for (const [key, generation] of eligible) {
    if (deferred && generation.presenceOwned && !generation.activationEligible) {
      continue;
    }
    try {
      generation.retention = await options.prepareRetention(
        generation.source,
        generation.preparation,
        signal,
        (reason) => pool.skipRefill(ctx, generation.source, reason),
      );
      signal.throwIfAborted();
      if (!generation.retention) {
        eligible.delete(key);
      }
    } catch (error) {
      signal.throwIfAborted();
      pool.deferGeneration(ctx, generation, error);
    }
  }
  let plannedTotal = 0;
  for (const [key, generation] of eligible) {
    signal.throwIfAborted();
    if (generation.deferred) {
      continue;
    }
    const { source } = generation;
    const limits = pool.poolPolicy(options, source.profileId, source.providerId);
    const project = readWorkerProjectSnapshot(source.profileSnapshot.project);
    const capacity = {
      profileId: source.profileId,
      projectKey: workerPreparationSourceKey(source.profileSnapshot)!,
      ...limits,
    };
    const slots = store.preparedCapacity({
      ...capacity,
      maxTotal: Math.max(0, limits.maxTotal - plannedTotal),
    });
    if (
      generation.expiresAtMs <= now() ||
      (!presence.isPresent() &&
        demand &&
        generation.preparation.key === demand.preparationKey &&
        !generation.activationEligible)
    ) {
      pool.skipRefill(ctx, source, "demand expired or authenticated presence ended");
      continue;
    }
    if (slots === 0) {
      if (store.preparedCapacity({ ...capacity, maxTotal: Number.MAX_SAFE_INTEGER }) > 0) {
        pool.skipRefill(ctx, source, "shared prepared capacity reached");
      }
      continue;
    }
    try {
      const preparation = generation.preparation;
      const intent = await options.prepareIntent(source.profileId, {
        ...(project
          ? "source" in project
            ? { projectRepository: project }
            : { projectPath: project.root, projectCommit: project.baseCommit }
          : { emptyWorkspace: true }),
        ...readWorkerProfileSelection(source.profileSnapshot),
        setupAuthorized:
          preparation.setupRecipe !== undefined && preparation.runSetupScript !== false,
        runSetupScript: preparation.runSetupScript,
        signal,
      });
      signal.throwIfAborted();
      const admittedPreparation =
        intent.profileSnapshot.runtimePreparation ?? intent.profileSnapshot.project?.preparation;
      if (intent.providerId !== source.providerId || admittedPreparation?.key !== preparation.key) {
        pool.skipRefill(ctx, source, "refill intent no longer matches the activated preparation");
        eligible.delete(key);
        continue;
      }
      generation.intent = intent;
      generation.slots = slots;
      plannedTotal += slots;
    } catch (error) {
      signal.throwIfAborted();
      ctx.reportRefill(
        `Prepared worker refill deferred (${source.profileId}, ${source.environmentId}): ${boundedWorkerError(error)}`,
      );
    }
  }
  return eligible;
}
async function launchReserves(
  ctx: pool.PassContext,
  eligible: pool.Generations,
  work: Environment[],
): Promise<Environment[]> {
  const { options } = ctx;
  const { store, signal } = options;
  for (const generation of eligible.values()) {
    const { source, intent, demandAtMs, expiresAtMs } = generation;
    if (!intent) {
      continue;
    }
    const limits = pool.poolPolicy(options, source.profileId, source.providerId);
    for (let index = 0; index < generation.slots!; index += 1) {
      signal.throwIfAborted();
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId: intent.providerId,
          profileId: source.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: generation.preparation.key,
            demandAtMs,
            expiresAtMs,
          },
        },
        projectKey:
          intent.profileSnapshot.runtimePreparation?.source ?? intent.profileSnapshot.project!.key,
        ...limits,
        assertCurrent: () => pool.assertGenerationCurrent(ctx, generation),
      });
      if (!admitted) {
        break;
      }
      work.push(admitted);
    }
  }
  return work;
}

/** Environment rows own inventory; placement activation and explicit builds establish demand. */
export function createPreparedWorkerPool(options: pool.PoolOptions) {
  const { store, signal, now } = options;
  let inFlight: Promise<void> | undefined;
  let requested = false;
  let presenceInFlight: Promise<void> | undefined;
  let presenceAdmitted = false;
  const preparations = new Map<string, AbortController>();
  let previousDiagnostics = new Set<string>();
  const presence = createPreparedPoolPresence({ ...options, schedule: () => schedule() });
  const scheduleInventory = () => {
    if (signal.aborted) {
      return Promise.resolve();
    }
    requested = true;
    return (inFlight ??= (async () => {
      try {
        while (requested && !signal.aborted) {
          requested = false;
          const diagnostics = new Set<string>();
          try {
            const { store: passStore, signal: passSignal } = options;
            await passStore.ready();
            passSignal.throwIfAborted();
            const activeDemand = presence.current();
            const presenceDeferred = !presenceAdmitted;
            const inventory = passStore.list();
            const ctx: pool.PassContext = {
              options,
              presence,
              preparations,
              isAdmitted: () => presenceAdmitted,
              activeDemand,
              presenceDeferred,
              inventory,
              oldestFirst: inventory.toSorted((a, b) => a.createdAtMs - b.createdAtMs),
              reportRefill: (message) => {
                if (!diagnostics.has(message) && !previousDiagnostics.has(message)) {
                  options.warn(message);
                }
                diagnostics.add(message);
              },
            };
            const eligible = pool.admitSources(ctx);
            // Expiry and disabled/surplus capacity need no source or artifact admission.
            // Drain that cleanup first so unrelated GitHub latency cannot hold its owner.
            const initial = await retain(ctx, eligible, new Set<string>(), false);
            await reconcileAll(ctx, eligible, initial.cleanup);
            const planned = await planRefill(ctx, eligible);
            const retained = await retain(ctx, planned, initial.cleaned, true);
            await reconcileAll(ctx, planned, retained.cleanup);
            const work = await launchReserves(ctx, planned, retained.work);
            await reconcileAll(ctx, planned, work);
          } finally {
            // Repeat only after recovery or a changed reason; retain at most one pass's diagnostics.
            previousDiagnostics = diagnostics;
          }
        }
      } finally {
        inFlight = undefined;
      }
    })());
  };
  const schedule = async () => {
    if (signal.aborted) {
      return;
    }
    await store.ready();
    await presence.ready();
    signal.throwIfAborted();
    // Repository admission has one owner and one in-flight operation, but cannot
    // hold inventory cleanup or independently authorized project refill hostage.
    const admission = (presenceInFlight ??= (async () => {
      presenceAdmitted = false;
      const previousDemand = presence.current();
      try {
        await presence.maintain();
        presenceAdmitted = true;
      } finally {
        presenceInFlight = undefined;
        if (previousDemand || presence.current()) {
          await scheduleInventory();
        }
      }
    })());
    const results = await Promise.allSettled([admission, scheduleInventory()]);
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  };
  const noteDemand = async (environmentId: string) => {
    signal.throwIfAborted();
    const record = store.get(environmentId);
    const preparation = record && readWorkerPreparation(record.profileSnapshot);
    if (record?.state !== "attached" || !record.leaseId || !preparation) {
      return;
    }
    const demandAtMs = record.lastActivatedAtMs;
    if (demandAtMs === null) {
      return;
    }
    const provider = options.resolveProvider(record.providerId);
    await provider?.notePreparedDemand?.(
      { leaseId: record.leaseId, profile: pool.snapshotSettings(record) },
      { preparationKey: preparation.key, demandAtMs },
    );
  };
  const candidates = (intent: WorkerProviderPreparedIntent) => {
    const preparation =
      intent.profileSnapshot.runtimePreparation ?? intent.profileSnapshot.project?.preparation;
    return preparation
      ? store.list().filter((record) => {
          const limits = pool.poolPolicy(options, record.profileId, record.providerId);
          const presenceDemand = presence.current();
          return (
            limits.target > 0 &&
            limits.maxTotal > 0 &&
            record.state === "ready" &&
            record.providerId === intent.providerId &&
            record.preparation !== null &&
            record.preparation.key === preparation.key &&
            record.preparation.consumedAtMs === null &&
            ((presenceDemand &&
              presenceDemand.project.key ===
                readWorkerProjectSnapshot(record.profileSnapshot.project)?.key &&
              (presenceDemand.retireAtMs ?? Number.MAX_SAFE_INTEGER) > now()) ||
              record.preparation.expiresAtMs > now()) &&
            record.destroyRequestedAtMs === null &&
            record.sharedHost === false &&
            record.nodeDeviceId !== null &&
            record.leaseId !== null
          );
        })
      : [];
  };
  const maintain = async (environmentId?: string) => {
    if (signal.aborted) {
      return;
    }
    if (environmentId) {
      await noteDemand(environmentId).catch(() => {
        if (!signal.aborted) {
          options.warn("Prepared snapshot demand could not be recorded");
        }
      });
    }
    await schedule().catch((error: unknown) => {
      if (!signal.aborted) {
        options.warn(`Prepared worker maintenance will retry: ${boundedWorkerError(error)}`);
      }
    });
  };
  const canPruneDemand = (record: Environment, nowMs: number): boolean => {
    const demandAtMs = pool.demandAt(record);
    if (demandAtMs === undefined || !readWorkerPreparation(record.profileSnapshot)) {
      return true;
    }
    const presenceDemand = matchingPreparedPoolPresenceDemand(record, presence.current());
    if (presenceDemand) {
      return presenceDemand.retireAtMs !== null && presenceDemand.retireAtMs <= nowMs;
    }
    // Unavailable policy cannot prove expiry. Retain metadata only; physical
    // cleanup is independent and must not wait for a provider to return.
    try {
      const timeout = options
        .resolveProvider(record.providerId)
        ?.resolvePreparedIdleTimeoutMs?.(pool.snapshotSettings(record));
      return (
        timeout !== undefined &&
        Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        demandAtMs + timeout <= nowMs
      );
    } catch {
      return false;
    }
  };
  const cancelPreparation = async (environmentId: string) => {
    await store.ready();
    const record = store.get(environmentId);
    const controller = preparations.get(environmentId);
    if (record?.preparation && (await pool.retirePoolRecord(options, record, "invalidated"))) {
      // The durable cancellation fences readiness; the lifecycle retains provider
      // custody until its aborted operation and physical cleanup actually settle.
      controller?.abort();
    }
  };
  return {
    schedule,
    noteDemand,
    candidates,
    maintain,
    canPruneDemand,
    cancelPreparation,
    summary: () => ({
      maxTotal: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? pool.DEFAULT_MAX_TOTAL,
      reservedEnvironmentIds: store.preparedReservationEnvironmentIds(),
    }),
    target: (profileId: string) => pool.poolPolicy(options, profileId).target,
    setHumanPresence: presence.set,
  };
}
