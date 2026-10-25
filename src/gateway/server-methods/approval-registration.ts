import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  captureWorkerTurnLiveEventOwner,
  type WorkerTurnLiveEventOwner,
} from "../worker-environments/worker-turn-run-owner.js";
import { handlePendingApprovalRequestWithDelivery } from "./approval-request-delivery.js";
import { respondApprovalStorageUnavailable } from "./approval-shared.js";

/** Capture the validated requester before any approval preparation can yield. */
export function captureApprovalWorkerOwner(
  runtimeIdentity: AgentRuntimeIdentity | undefined,
): WorkerTurnLiveEventOwner | undefined {
  const delegated = runtimeIdentity?.delegatedAuthority;
  return delegated?.kind === "worker"
    ? captureWorkerTurnLiveEventOwner({
        sessionId: delegated.turnClaim.sessionId,
        turnClaim: delegated.turnClaim,
      })
    : undefined;
}

/** Register before delivery; only registration failures become storage errors. */
export async function registerPendingApprovalRequestWithDelivery<TKind extends "exec" | "plugin">(
  params: Parameters<typeof handlePendingApprovalRequestWithDelivery<TKind>>[0] & {
    timeoutMs: number;
    workerOwner?: WorkerTurnLiveEventOwner;
  },
): Promise<void> {
  try {
    const registration = await params.manager.register(params.record, params.timeoutMs);
    if (params.workerOwner && params.manager.isPending(params.record)) {
      const wait = params.workerOwner.beginApprovalWait(params.record.expiresAtMs, () =>
        params.manager.isPending(params.record),
      );
      if (wait) {
        // Decision, expiry and withdrawal settle this original registration.
        void registration.decision.then(
          () => wait.close(),
          () => wait.close(),
        );
      }
    }
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
    return;
  }
  await handlePendingApprovalRequestWithDelivery(params);
}
