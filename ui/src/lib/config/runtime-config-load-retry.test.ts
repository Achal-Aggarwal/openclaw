// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createConfigCapabilityHarness, createGatewayHarness } from "./config-test-harness.ts";
import { makeSnapshot } from "./config-write.test-support.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("runtime config load retries", () => {
  // Solid effects re-ensure config on a later microtask after each publication;
  // the cap keeps a regression from spinning the test forever.
  function reensureOnPublish(
    runtimeConfig: { subscribe: (listener: () => void) => () => void },
    ensure: () => Promise<void>,
  ) {
    let calls = 0;
    const stop = runtimeConfig.subscribe(() => {
      if (calls < 50) {
        calls += 1;
        queueMicrotask(() => void ensure().catch(() => undefined));
      }
    });
    return { stop, calls: () => calls };
  }
  const settleMicrotasks = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  it.each([
    {
      name: "releases loading after a failed display read so the editor can be explicitly reloaded",
      reload: "discard",
    },
    {
      name: "keeps reload available when editing opens after a failed display read",
      reload: "refresh",
    },
  ] as const)("$name", async ({ reload }) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(makeSnapshot({ config: { count: 1 }, hash: "recovered" }));
    const { runtimeConfig, state } = createConfigCapabilityHarness(request);
    let observed: { loading: boolean; error: string | null } | undefined;
    const unsubscribe = runtimeConfig.subscribe((current) => {
      observed = { loading: current.configLoading, error: current.lastError };
    });
    try {
      await runtimeConfig.ensureDisplayLoaded();
      expect(state.lastError).toBe("temporarily unavailable");

      await runtimeConfig.ensureLoaded();
      expect(request).toHaveBeenCalledOnce();
      expect(observed).toEqual({ loading: false, error: "temporarily unavailable" });
      expect(state.configLoading).toBe(false);

      await (reload === "discard"
        ? runtimeConfig.discardDraft({ reloadOnly: true })
        : runtimeConfig.refresh());
      expect(request).toHaveBeenCalledTimes(2);
      expect(state.configForm).toEqual({ count: 1 });
      expect(state.configSnapshot?.hash).toBe("recovered");
      expect(observed).toEqual({ loading: false, error: null });
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps a shared editor read busy when concurrent callers wait for activation", async () => {
    const first = deferred<ConfigSnapshot>();
    const request = vi.fn(() => first.promise);
    const { runtimeConfig, state } = createConfigCapabilityHarness(request);
    let observedLoading: boolean | undefined;
    const unsubscribe = runtimeConfig.subscribe((current) => {
      observedLoading = current.configLoading;
    });
    const pending = [runtimeConfig.ensureLoaded(), runtimeConfig.ensureLoaded()];
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(state.configLoading).toBe(true);
      expect(observedLoading).toBe(true);
      first.resolve(makeSnapshot());
      await Promise.all(pending);
      expect(observedLoading).toBe(false);
      expect(state.configLoading).toBe(false);
      expect(state.configSnapshot?.hash).toBe("hash-1");
    } finally {
      first.resolve(makeSnapshot());
      await Promise.all(pending);
      unsubscribe();
      runtimeConfig.dispose();
    }
  });

  it.each(["display", "editor"] as const)(
    "does not republish %s loads that cannot start before read access",
    async (kind) => {
      const request = vi.fn(async () => makeSnapshot());
      const client = {
        request,
        auth: { role: "operator", scopes: ["operator.sessions.read"] },
      } as unknown as GatewayBrowserClient;
      const { gateway } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const ensure =
        kind === "display" ? runtimeConfig.ensureDisplayLoaded : runtimeConfig.ensureLoaded;
      const observer = reensureOnPublish(runtimeConfig, ensure);
      try {
        await ensure();
        await settleMicrotasks();
        expect(observer.calls()).toBeLessThan(3);
        expect(request).not.toHaveBeenCalled();
      } finally {
        observer.stop();
        runtimeConfig.dispose();
      }
    },
  );

  it.each(["display", "editor"] as const)(
    "retries failed %s loads only after a cooldown or an explicit refresh",
    async (kind) => {
      vi.useFakeTimers();
      const request = vi.fn(async () => {
        throw new Error("gateway restarting");
      });
      const { runtimeConfig } = createConfigCapabilityHarness(request);
      const ensure =
        kind === "display" ? runtimeConfig.ensureDisplayLoaded : runtimeConfig.ensureLoaded;
      const observer = reensureOnPublish(runtimeConfig, ensure);
      try {
        await ensure().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(5_000);
        await ensure().catch(() => undefined);
        expect(request).toHaveBeenCalledTimes(2);

        // An explicit refresh is the user's retry and never waits for the cooldown.
        await (kind === "display" ? runtimeConfig.refreshDisplay() : runtimeConfig.refresh()).catch(
          () => undefined,
        );
        expect(request).toHaveBeenCalledTimes(3);
      } finally {
        observer.stop();
        runtimeConfig.dispose();
        vi.useRealTimers();
      }
    },
  );
});
