import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { tryBeginGatewaySuspendAdmission } from "../process/gateway-work-admission.js";
import { createDeferredWorkTracker } from "../shared/async-work-scope.test-support.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import {
  installGatewayHookModuleLoad,
  installGatewaySubagentModuleLoad,
  type GatewayStartupModuleMocks,
} from "./server-startup-module-mocks.test-support.js";
import type { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";
import { createStartupMethodUnlocker } from "./server-startup-readiness.test-support.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";
import { createStartupGate } from "./server-startup-state.test-support.js";

type PostAttachParams = Parameters<typeof startGatewayPostAttachRuntime>[0];

export function registerGatewayStartupAdmissionTests(params: {
  mocks: typeof import("./server-startup-post-attach.mocks.test-support.js").postAttachMocks;
  workspaceDir: () => string;
  start: (
    params: PostAttachParams,
    runtimeDeps?: GatewayStartupModuleMocks,
  ) => ReturnType<typeof startGatewayPostAttachRuntime>;
  createParams: (overrides?: Partial<PostAttachParams>) => PostAttachParams;
  createRuntimeDeps: (overrides?: Partial<GatewayStartupModuleMocks>) => GatewayStartupModuleMocks;
  startupModuleRestorers: Array<() => void>;
  stopSidecar: (sidecar: GatewayPostReadySidecarHandle) => Promise<void>;
}): void {
  const hoisted = params.mocks;
  it("overlaps marking with sidecar preparation while keeping agent admission gated", async ({
    signal,
  }) => {
    const methods = ["chat.history", "models.list", "agent", "sessions.send", "chat.send"];
    const unavailableGatewayMethods = new Set(methods);
    const startupOrder: string[] = [];
    const postReadyWork = createDeferred();
    const markingEntered = createDeferred();
    const releaseMarking = createDeferred();
    const modelEntered = createDeferred();
    const releaseModel = createDeferred();
    hoisted.refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(async () => {
      modelEntered.resolve();
      await releaseModel.promise;
    });
    const startChannels = vi.fn(async () => {});
    hoisted.markStartupOrphanedMainSessionsForRecovery.mockImplementationOnce(async () => {
      markingEntered.resolve();
      await releaseMarking.promise;
      return { marked: 0, skipped: 0 };
    });
    const recoveryActivated = createDeferred();
    const chatReady = createDeferred();
    const methodsAtRecoveryRegistration: string[][] = [];
    const currentConfig = { agents: { entries: { main: {}, work: {} } } };
    hoisted.scheduleRestartAbortedMainSessionRecovery.mockImplementationOnce(
      (recovery: { getConfig: () => unknown }) => {
        methodsAtRecoveryRegistration.push([...unavailableGatewayMethods]);
        expect(recovery.getConfig()).toBe(currentConfig);
      },
    );
    const onSidecarsReady = vi.fn(() => startupOrder.push("ready"));
    hoisted.activateSubagentRegistry.mockImplementationOnce(() => {
      expect([...unavailableGatewayMethods]).toStrictEqual(["chat.send"]);
      startupOrder.push("registry");
      recoveryActivated.resolve();
      return hoisted.createRecoveryProgress();
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    try {
      const runtime = await params.start({
        ...params.createParams(),
        sidecarStartup: "defer",
        getConfig: () => currentConfig,
        startChannels,
        waitForPostReadyWork: () => postReadyWork.promise,
        log,
        unlockStartupMethods: (options) => {
          startupOrder.push("unlock");
          createStartupMethodUnlocker(unavailableGatewayMethods)(options);
          if (unavailableGatewayMethods.size === 0) {
            chatReady.resolve();
          }
        },
        onSidecarsReady,
      });

      await withinTest(modelEntered.promise, signal);
      await withinTest(markingEntered.promise, signal);
      expect([...unavailableGatewayMethods]).toStrictEqual(methods);
      expect(onSidecarsReady).not.toHaveBeenCalled();
      expect(startChannels).not.toHaveBeenCalled();
      releaseModel.resolve();
      await runtime.startupSettled;
      expect([...unavailableGatewayMethods]).toStrictEqual(methods);
      expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
      expect(hoisted.prepareInternalHooks).toHaveBeenCalledWith(
        { hooks: { internal: { enabled: false } } },
        params.workspaceDir(),
        {
          failureMode: "best-effort",
          selection: { configured: false, names: new Set(), declaredNames: new Set() },
        },
      );
      expect(hoisted.commitInternalHooks).toHaveBeenCalledWith({ initial: true });
      expect(hoisted.logGatewayStartup).toHaveBeenCalledTimes(1);
      expect(hoisted.logGatewayStartup).toHaveBeenCalledWith(
        expect.objectContaining({ loadedPluginIds: ["beta", "alpha"] }),
      );
      expect(hoisted.logGatewayStartup).toHaveBeenCalledWith(
        expect.objectContaining({
          activationSourceConfig: { hooks: { internal: { enabled: false } } },
        }),
      );
      expect(hoisted.scheduleRestartAbortedMainSessionRecovery).toHaveBeenCalledWith({
        getConfig: expect.any(Function),
        shouldContinue: expect.any(Function),
        startupCheckedStorePaths: expect.any(Set),
        waitForStart: expect.any(Function),
        gatewayRuntime: expect.any(Object),
      });
      expect(hoisted.activateSubagentRegistry).not.toHaveBeenCalled();
      expect(startupOrder).toEqual([]);
      expect(startChannels).not.toHaveBeenCalled();
      expect(hoisted.markStartupOrphanedMainSessionsForRecovery).toHaveBeenCalledOnce();
      releaseMarking.resolve();
      await recoveryActivated.promise;
      expect(startChannels).toHaveBeenCalledOnce();
      await chatReady.promise;
      expect([...unavailableGatewayMethods]).toStrictEqual([]);
      expect(hoisted.activateSubagentRegistry).toHaveBeenCalledWith(
        expect.any(Function),
        undefined,
      );
      expect(startupOrder).toEqual(["unlock", "ready", "registry", "unlock"]);
      expect(methodsAtRecoveryRegistration).toStrictEqual([methods]);
    } finally {
      postReadyWork.resolve();
      releaseModel.resolve();
      releaseMarking.resolve();
    }
  });

  it("does not activate restored recovery when close begins during activation loading", async () => {
    const postReadyWork = createDeferred();
    const tracked: Promise<unknown>[] = [];
    const lifetime = new AbortController();
    const recoveryLoad = createStartupGate();
    const unlockStartupMethods = vi.fn();
    const activateSubagentRegistry = vi.fn(() => ({
      initial: Promise.resolve(),
      pending: new Map(),
      settled: Promise.resolve(),
    }));
    await installGatewaySubagentModuleLoad(
      recoveryLoad.run,
      activateSubagentRegistry,
      params.startupModuleRestorers,
    );
    const runtime = await params.start(
      {
        ...params.createParams(),
        sidecarStartup: "defer",
        waitForPostReadyWork: () => postReadyWork.promise,
        trackStartupWork: (run) => {
          const work = run(lifetime.signal);
          tracked.push(work);
          return work;
        },
        isClosing: () => lifetime.signal.aborted,
        unlockStartupMethods,
      },
      params.createRuntimeDeps(),
    );

    try {
      await runtime.startupSettled;
      expect(activateSubagentRegistry).not.toHaveBeenCalled();
      postReadyWork.resolve();
      await recoveryLoad.entered;
      lifetime.abort();
      recoveryLoad.release();
      await Promise.allSettled(tracked);

      expect(activateSubagentRegistry).not.toHaveBeenCalled();
      expect(unlockStartupMethods).toHaveBeenCalledOnce();
    } finally {
      lifetime.abort();
      postReadyWork.resolve();
      recoveryLoad.release();
      await Promise.allSettled(tracked);
    }
  });

  it.each(["orphans", "gateway_start"] as const)(
    "retires startup %s admission parked behind suspension when the Gateway closes",
    async (stage) => {
      const gatewayStart = vi.fn<PluginHookHandlerMap["gateway_start"]>(async () => {});
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.typedHooks.push({
        pluginId: "startup-suspension-test",
        hookName: "gateway_start",
        handler: gatewayStart,
        source: "startup-suspension-test",
      });
      const postReadyWork = createDeferred();
      const hookLoad = createStartupGate();
      const connectionWork = new GatewayConnectionWork();
      const refreshStarted = createDeferred();
      const refresh = vi.fn(async () => {
        refreshStarted.resolve();
        return null;
      });
      const sidecarsReady = vi.fn();
      // The orphan row isolates recovery admission; the hook row owns hook admission.
      if (stage === "orphans") {
        pluginRegistry.typedHooks.length = 0;
        hookLoad.release();
      }
      await installGatewayHookModuleLoad(hookLoad.run, params.startupModuleRestorers);
      const trackStartupWork = createDeferredWorkTracker(connectionWork);
      let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
      const admissionParked = createDeferred();
      const runWithAdmission = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
      const admissionSpy = vi
        .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation((run, origin, signal) => {
          const work = runWithAdmission(run, origin, signal);
          if (
            origin ===
            (stage === "orphans" ? "startup:main-session-orphans" : "hooks:gateway-start")
          ) {
            admissionParked.resolve();
          }
          return work;
        });
      let runtime: Awaited<ReturnType<typeof params.start>> | undefined;
      try {
        if (stage === "orphans") {
          suspension = tryBeginGatewaySuspendAdmission(() => {});
          expect(suspension?.commit()).toBe(true);
        }
        runtime = await trackStartupWork(() =>
          params.start(
            params.createParams({
              pluginRegistry,
              isClosing: () => connectionWork.isClosing,
              trackStartupWork,
              onSidecarsReady: sidecarsReady,
              waitForPostReadyWork: () => postReadyWork.promise,
            }),
            params.createRuntimeDeps({
              refreshLatestUpdateRestartSentinel: refresh,
            }),
          ),
        );
        if (stage === "gateway_start") {
          postReadyWork.resolve();
          await hookLoad.entered;
          await refreshStarted.promise;
          suspension = tryBeginGatewaySuspendAdmission(() => {});
          expect(suspension?.commit()).toBe(true);
        } else {
          expect(sidecarsReady).not.toHaveBeenCalled();
        }
        postReadyWork.resolve();
        hookLoad.release();
        // Dynamic imports can outlive a turn; close only after the real admission waiter parks.
        await admissionParked.promise;
        connectionWork.beginClose();
        // Close retains admitted imports, but must retire parked admission without reopening it.
        await connectionWork.drain();
        expect(sidecarsReady).toHaveBeenCalledTimes(stage === "orphans" ? 0 : 1);
        expect(gatewayStart).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(stage === "orphans" ? 0 : 1);
      } finally {
        admissionSpy.mockRestore();
        suspension?.release();
        postReadyWork.resolve();
        hookLoad.release();
        await runtime?.startupSettled;
        await connectionWork.drain();
      }
    },
  );
}
