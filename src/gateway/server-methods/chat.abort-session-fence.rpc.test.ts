import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { abortSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  getWorkerInferenceSessionControl,
  registerWorkerInferenceSessionControl,
} from "../worker-environments/inference-control-internal.js";
import {
  createWorkerInferenceCancellationService,
  createWorkerInferenceServiceStub,
} from "../worker-environments/inference-control.test-helpers.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { GatewayClient } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:abort-fence",
  sessionId: "current-session",
};

async function withAbortFixture(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const fixture = await createFixture();
    try {
      await run(fixture);
    } finally {
      for (const source of fixture.sources) {
        abortSessionControllerInput(source.input, "Fixture finished");
      }
      await Promise.all(fixture.sources.map((source) => source.input.settlement.promise));
      rpcSourceTesting.reset();
      await disposeSessionReadContexts();
    }
  });
}

async function createFixture() {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const owner = roleClient("write", "abort-owner");
  owner.connId = "abort-owner";
  const other = roleClient("write", "abort-other");
  other.connId = "abort-other";
  const admin: GatewayClient = {
    ...owner,
    connect: { ...owner.connect, scopes: ["operator.admin"] },
  };
  // Keep the configured role ceiling consistent with the admin test connection.
  expectDefined(cfg.gateway?.roles?.definitions.write, "writer role").scopes.push("operator.admin");
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(owner.authenticatedUserProfile, "owner profile").profileId,
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  const sources: RpcSourceRef[] = [];
  const register = (runId: string, sessionId = scope.sessionId, queued = true) => {
    const source = createActiveRun(scope.sessionKey, {
      agentId: scope.agentId,
      sessionId,
      owner: { connId: owner.connId },
      queued,
    });
    sources.push(source);
    rpcSourceTesting.set(runId, source);
    return source;
  };
  return {
    context,
    owner,
    other,
    admin,
    sources,
    register,
    abort: (params: Record<string, unknown>, client = admin) =>
      chatRpc(context, client, "chat.abort", { sessionKey: scope.sessionKey, ...params }),
  };
}

it("fences exact local runs without granting cancellation authority or stopping siblings", () =>
  withAbortFixture(async (f) => {
    const selected = f.register("selected", scope.sessionId, false);
    const sibling = f.register("sibling");
    const reject = async (params: Record<string, unknown>, message: string, client = f.admin) => {
      expect(await f.abort(params, client)).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message },
      ]);
      expect(selected.input.abortSignal.aborted).toBe(false);
      expect(sibling.input.abortSignal.aborted).toBe(false);
    };
    await reject({ sessionId: scope.sessionId }, "sessionId requires an exact runId");
    await reject(
      { sessionId: "previous-session", runId: "selected" },
      "session incarnation changed",
    );
    await reject({ sessionId: scope.sessionId, runId: "selected" }, "unauthorized", f.other);
    const narrow = {
      ...f.owner,
      connect: { ...f.owner.connect, scopes: ["operator.sessions.write"] },
    };
    await reject(
      { sessionId: "previous-session", runId: "selected" },
      "session incarnation changed",
      narrow,
    );
    expect(await f.abort({ sessionId: scope.sessionId, runId: "selected" }, f.owner)).toMatchObject(
      [true, { aborted: true, runIds: ["selected"] }],
    );
    expect(selected.input.abortSignal.aborted).toBe(true);
    expect(sibling.input.abortSignal.aborted).toBe(false);
    expect(await f.abort({})).toMatchObject([true, { aborted: true, runIds: ["sibling"] }]);
    expect(sibling.input.abortSignal.aborted).toBe(true);
  }));

it("rejects a mismatched local or worker incarnation and cancels only the matching worker run", () =>
  withAbortFixture(async (f) => {
    const local = f.register("old-local", "previous-session");
    expect(await f.abort({ sessionId: scope.sessionId, runId: "old-local" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: "runId does not match session incarnation" },
    ]);
    expect(local.input.abortSignal.aborted).toBe(false);
    const workers = new Set(["worker", "worker-sibling"]);
    const attachWorker = (sessionId: string) => {
      const service = createWorkerInferenceCancellationService(
        sessionId,
        [...workers],
        ({ runId }) => {
          expect(runId).toBe("worker");
          const cancelled = expectDefined(runId, "exact worker run");
          workers.delete(cancelled);
          return [cancelled];
        },
        { ...scope, sessionId, storePath: "/synthetic/worker-store" },
      );
      f.context.workerEnvironmentService = createWorkerInferenceServiceStub();
      registerWorkerInferenceSessionControl(
        f.context.workerEnvironmentService,
        expectDefined(getWorkerInferenceSessionControl(service), "worker cancellation owner"),
      );
    };
    attachWorker("previous-session");
    expect(await f.abort({ sessionId: scope.sessionId, runId: "worker" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: "runId does not match session incarnation" },
    ]);
    expect([...workers]).toEqual(["worker", "worker-sibling"]);
    attachWorker(scope.sessionId);
    expect(await f.abort({ sessionId: "previous-session", runId: "worker" })).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: "session incarnation changed" },
    ]);
    expect([...workers]).toEqual(["worker", "worker-sibling"]);
    expect(await f.abort({ sessionId: scope.sessionId, runId: "worker" })).toMatchObject([
      true,
      { aborted: true, runIds: ["worker"] },
    ]);
    expect([...workers]).toEqual(["worker-sibling"]);
    expect(local.input.abortSignal.aborted).toBe(false);
  }));
