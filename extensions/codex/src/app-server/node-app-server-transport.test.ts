import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexWorkerClientFactory } from "./node-app-server-transport.js";
import { releaseCodexProbeClient } from "./shared-client.js";

afterEach(() => vi.unstubAllEnvs());

async function connect() {
  vi.stubEnv("OPENCLAW_WORKER_CODEX_CONFIG_VERSION", "a".repeat(64));
  const closed = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  let receive: ((frame: Uint8Array) => void | Promise<void>) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  let current = true;
  const runtime: Pick<PluginRuntime, "nodes"> = {
    nodes: {
      list: async () => {
        throw new Error("Unexpected discovery");
      },
      invoke: async () => {
        throw new Error("Unexpected unary invocation");
      },
      openDuplex: async () => ({
        send: async (frame) => {
          const request = JSON.parse(Buffer.from(frame).toString("utf8")) as Record<
            string,
            unknown
          >;
          sent.push(request);
          if (request.method === "initialize") {
            await receive?.(
              Buffer.from(
                JSON.stringify({ id: request.id, result: { userAgent: "codex-cli/0.164.0" } }),
              ),
            );
          } else if (request.id !== undefined) {
            await receive?.(Buffer.from(JSON.stringify({ id: request.id, result: { ok: true } })));
          }
        },
        onMessage: (listener) => {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        close: () => closing.resolve(),
        closed: closed.promise,
      }),
    },
  };
  const open = vi.spyOn(runtime.nodes, "openDuplex");
  const sandbox = {
    ...createSandboxTestContext(),
    placementExecutionMode: "remote-exec",
    placementNodeId: "node",
    placementEnvironmentId: "environment",
    placementSessionId: "session",
    placementOwnerEpoch: 1,
  };
  const factory = createCodexWorkerClientFactory({
    runtime,
    permissionMode: "full",
    sandbox,
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Retired worker authority");
      }
    },
  });
  const client = await factory();
  return {
    client,
    factory,
    closed,
    closing,
    sent,
    open,
    retire: () => {
      current = false;
    },
    deliver: async (value: unknown) => receive?.(Buffer.from(JSON.stringify(value))),
  };
}

it("uses the versioned placement duplex and joins caller-owned probe shutdown", async () => {
  const fixture = await connect();
  expect(fixture.open.mock.calls[0]?.[0]).toMatchObject({
    command: "codex.app-server.stdio.v1." + "a".repeat(64),
    nodeId: "node",
    params: {
      authorization: "session-full",
      placement: { environmentId: "environment", sessionId: "session", ownerEpoch: 1 },
    },
  });
  expect(await fixture.client.request("thread/read", { threadId: "thread" })).toEqual({ ok: true });
  let settled = false;
  const cleanup = releaseCodexProbeClient(fixture.client, fixture.factory).then(() => {
    settled = true;
  });
  await fixture.closing.promise;
  expect(settled).toBe(false);
  fixture.closed.resolve();
  await cleanup;
  expect(settled).toBe(true);
});

it.each(["native", "disconnect"] as const)("distinguishes %s from caller closure", async (mode) => {
  const fixture = await connect();
  if (mode === "native") {
    await fixture.deliver({
      method: "openclaw/process/exited",
      params: { code: 23, signal: null },
    });
  }
  fixture.closed.resolve();
  await fixture.closing.promise;
  expect(fixture.client.getCloseError()?.message).toContain(
    mode === "native" ? "exited" : "disconnected",
  );
  await fixture.client.closeAndWait();
});

it("rejects request effects after the admitted owner retires", async () => {
  const fixture = await connect();
  fixture.retire();
  const request = fixture.client.request("turn/start", { threadId: "thread" });
  await fixture.closing.promise;
  await expect(request).rejects.toThrow();
  expect(fixture.sent.some((message) => message.method === "turn/start")).toBe(false);
  let settled = false;
  const cleanup = releaseCodexProbeClient(fixture.client, fixture.factory, true).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  fixture.closed.resolve();
  await cleanup;
  expect(settled).toBe(true);
});
