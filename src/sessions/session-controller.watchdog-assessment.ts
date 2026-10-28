import type {
  ReplyBackendHandle,
  ReplyBackendTurnAssessment,
  ReplyBackendTurnStatus,
} from "./session-controller.backend-contracts.js";
import type { SessionControllerWatchdogAttempt } from "./session-controller.watchdog.js";

const ASSESSMENT_MS = 10_000;
type Owner = {
  current: boolean;
  attempt?: SessionControllerWatchdogAttempt;
  backend?: ReplyBackendHandle;
  sequence: number;
};
type Assessment = {
  backend: ReplyBackendHandle;
  status: ReplyBackendTurnStatus;
  attempt: SessionControllerWatchdogAttempt;
  sequence: number;
  startedAtMs: number;
  deadlineAtMs: number;
  controller: AbortController;
  captured?: ReturnType<ReplyBackendTurnStatus["capture"]>;
  result?: ReplyBackendTurnAssessment & { durationMs: number };
};

/** One private slot owned and timed by the operation watchdog, never by a plugin or registry. */
export function createWatchdogAssessment(readOwner: () => Owner, onSettled: () => void) {
  let slot: Assessment | undefined;
  const current = (target: Assessment) => {
    const owned = () => {
      const owner = readOwner();
      return (
        slot === target &&
        owner.current &&
        owner.attempt === target.attempt &&
        target.attempt.isCurrent() &&
        owner.sequence === target.sequence &&
        owner.backend === target.backend &&
        target.backend.turnStatus === target.status
      );
    };
    try {
      return owned() && (!target.captured || target.captured.isCurrent()) && owned();
    } catch {
      return false;
    }
  };
  const clear = () => {
    const previous = slot;
    slot = undefined;
    previous?.controller.abort();
  };
  const settle = (target: Assessment, result: ReplyBackendTurnAssessment, at: number) => {
    if (!current(target) || target.result) {
      return false;
    }
    const durationMs = Math.max(0, Math.min(at - target.startedAtMs, ASSESSMENT_MS));
    target.result =
      result.state === "closed"
        ? { state: "closed", basis: result.basis, durationMs }
        : { state: "unknown", basis: result.basis, durationMs };
    target.controller.abort();
    return true;
  };
  return {
    clear,
    check(at: number) {
      if (slot && !current(slot)) {
        clear();
      }
      if (slot && !slot.result && at >= slot.deadlineAtMs) {
        settle(slot, { state: "unknown", basis: "timeout" }, at);
      }
    },
    pendingWait() {
      return slot && !slot.result && current(slot)
        ? { kind: "backend" as const, deadlineAtMs: slot.deadlineAtMs }
        : undefined;
    },
    result: () => (slot && current(slot) ? slot.result : undefined),
    captureCurrent() {
      const target = slot;
      return target && current(target) ? () => current(target) : undefined;
    },
    begin(at: number, executionDeadlineAtMs?: number) {
      const { attempt, backend, sequence } = readOwner();
      const status = backend?.turnStatus;
      if (slot || !attempt?.isCurrent() || !backend || !status) {
        return false;
      }
      const target: Assessment = {
        backend,
        status,
        attempt,
        sequence,
        startedAtMs: at,
        deadlineAtMs: Math.min(at + ASSESSMENT_MS, executionDeadlineAtMs ?? Infinity),
        controller: new AbortController(),
      };
      // Publish the wait before any external capture or assessment can reenter tick.
      slot = target;
      try {
        target.captured = status.capture();
        if (current(target)) {
          if (!target.captured) {
            settle(target, { state: "unknown", basis: "status_unsupported" }, at);
          } else {
            const finish = (result: ReplyBackendTurnAssessment) => {
              const finishedAt = Date.now();
              if (
                settle(
                  target,
                  finishedAt >= target.deadlineAtMs
                    ? { state: "unknown", basis: "timeout" }
                    : result,
                  finishedAt,
                )
              ) {
                onSettled();
              }
            };
            void target.captured
              .assess({ signal: target.controller.signal })
              .then(finish, () => finish({ state: "unknown", basis: "failed" }));
          }
        }
      } catch {
        settle(target, { state: "unknown", basis: "failed" }, Date.now());
      }
      return true;
    },
  };
}
