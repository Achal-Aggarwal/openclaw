import type { CliBackendTurnStatus } from "openclaw/plugin-sdk/cli-backend";
import type { ClaudeCliExecuteContext, ClaudeCliSession, ClaudeCliTurn } from "./cli.runtime.js";

/** Local facts only: this adapter never writes to the native transport. */
export function createClaudeTurnStatus(
  context: ClaudeCliExecuteContext,
  session: ClaudeCliSession,
  turn: ClaudeCliTurn,
): CliBackendTurnStatus {
  return {
    capture() {
      const generation = session.handle.generation;
      const inputUuid = turn.promptInputUuid;
      const submittedInputs = turn.submittedInputUuids.size;
      const inputStarted = turn.inputStarted;
      const isCurrent = () => {
        context.assertCurrent?.();
        return (
          !context.abortSignal?.aborted &&
          !turn.interrupted &&
          session.handle.generation === generation &&
          turn.promptInputUuid === inputUuid &&
          turn.submittedInputUuids.size === submittedInputs &&
          turn.inputStarted === inputStarted &&
          (session.currentTurn === turn || (session.closed && turn.error !== undefined))
        );
      };
      return {
        isCurrent,
        async assess({ signal }) {
          signal.throwIfAborted();
          if (!isCurrent()) {
            return { state: "unknown", basis: "status_unsupported" };
          }
          // closeSession also records host cancellation and startup failures, not just fatal errors.
          if (session.closed) {
            return { state: "closed", basis: "transport_closed" };
          }
          // No qualified read-only model-status request exists on this CLI transport.
          return {
            state: "unknown",
            basis:
              session.hasInputLifecycle && !inputStarted ? "status_unsupported" : "process_present",
          };
        },
      };
    },
  };
}
