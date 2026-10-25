import { randomUUID } from "node:crypto";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { readChannelContextAdmissionEvidence } from "../../channels/message-access/admission-evidence.js";
import { prepareCommandTranscriptInput } from "../../config/sessions/command-transcript.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import { withNativeSubagentRequest } from "../../plugins/runtime/native-subagent-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { buildChannelUserTurnSender } from "../../sessions/user-turn-transcript.metadata.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { normalizeMessageTimestampMs } from "./message-timestamp.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";
import { withRequesterNativeSubagents } from "./request-native-subagent.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

/** The run identity and input recorder of one live command turn. */
type CommandUserTurn = Readonly<{
  runId: string;
  userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
}>;

// One turn per dispatch, so a re-entered command reuses its committed input.
const channelTurns = new WeakMap<object, CommandUserTurn>();

/** Delivered-command mirror fields: a committed native command turn already holds the input. */
export function commandTranscriptMirror(dispatch: object, commandText: string, commandId: string) {
  return channelTurns.get(dispatch)?.userTurnTranscriptRecorder.getAdmissionReceipt()
    ? { commandText, commandId, commandInputCommitted: true }
    : { commandText, commandId };
}

type NativeSubagentDispatchState = Pick<
  PrepareDispatchOperationReadyState,
  | "cfg"
  | "ctx"
  | "sessionAgentId"
  | "sessionKey"
  | "getPreDispatchAbortSignal"
  | "assertProgressCurrent"
  | "assertCurrentBindingRoute"
  | "turnAdoption"
> & {
  params: Pick<PrepareDispatchOperationReadyState["params"], "replyOptions">;
  sessionStoreEntry: Pick<
    PrepareDispatchOperationReadyState["sessionStoreEntry"],
    "sessionKey" | "entry"
  >;
};

function requesterState(state: NativeSubagentDispatchState, turn?: CommandUserTurn) {
  const replyOptions = state.params.replyOptions;
  const entry = state.sessionStoreEntry.entry;
  const sessionKey = state.sessionStoreEntry.sessionKey ?? state.sessionKey;
  return {
    cfg: state.cfg,
    sessionAgentId: state.sessionAgentId,
    sessionKey,
    entry,
    runId: turn?.runId ?? replyOptions?.runId,
    operatorAuthority: replyOptions?.operatorAuthority,
    authorizeRequester: () =>
      resolveCommandAuthorizationAsync({
        ctx: state.ctx,
        cfg: state.cfg,
        commandAuthorized: state.ctx.CommandAuthorized,
      }),
    resolveToolAuthority: (owner: { senderIsOwner: boolean }) =>
      resolveInboundReplyToolAuthorityOverlay({
        ctx: state.ctx,
        sessionEntry: entry,
        senderIsOwner: owner.senderIsOwner,
        operatorAuthority: replyOptions?.operatorAuthority,
        toolsAllow: replyOptions?.toolsAllow,
        disableTools: replyOptions?.disableTools === true,
      }),
    messageChannel: state.ctx.OriginatingChannel ?? state.ctx.Provider ?? state.ctx.Surface,
    messageTo: state.ctx.OriginatingTo ?? state.ctx.To,
    getAbortSignal: () => {
      const signals = [state.getPreDispatchAbortSignal(), replyOptions?.abortSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      return signals.length ? AbortSignal.any(signals) : undefined;
    },
    assertCurrent: () => {
      state.assertProgressCurrent();
      state.turnAdoption?.assertCurrent();
    },
    commitTurn: async (assertCurrent: () => void) => {
      await state.assertCurrentBindingRoute();
      assertCurrent();
      await state.turnAdoption?.adopt();
      assertCurrent();
      const recorder = turn?.userTurnTranscriptRecorder ?? replyOptions?.userTurnTranscriptRecorder;
      if (!entry?.sessionId || !recorder || !(await recorder.resolveMessage())) {
        return false;
      }
      assertCurrent();
      await recorder.persistApproved({
        expectedSessionId: entry.sessionId,
        beforeFreshMessageCommit: assertCurrent,
      });
      assertCurrent();
      const receipt = recorder.getAdmissionReceipt();
      return Boolean(
        receipt &&
        receipt.sessionId === entry.sessionId &&
        receipt.sessionKey === sessionKey &&
        receipt.agentId === state.sessionAgentId,
      );
    },
    ingress: {
      ingressKind: "channel" as const,
      boundary: "auto-reply.reply-dispatch",
      evidence: readChannelContextAdmissionEvidence(state.ctx),
      gatewayLocalUserIngress: getGatewayLocalUserIngress(state.ctx),
    },
  };
}

/** Legacy hook and command invocations share the same requester/admission producer. */
export async function runWithReplyNativeSubagents<T>(
  state: NativeSubagentDispatchState,
  run: () => Promise<T>,
): Promise<T> {
  return await withRequesterNativeSubagents(requesterState(state), (create) =>
    withNativeSubagentRequest(async (guard) => {
      const runtime = await create(guard);
      if (!runtime) {
        throw new Error("Native subagents are unavailable for this requester.");
      }
      return runtime;
    }, run),
  );
}

export const runWithCommandNativeSubagents = async <T>(
  state: NativeSubagentDispatchState & { getDispatchAbortSignal: () => AbortSignal | undefined },
  binding: Parameters<NonNullable<InternalGetReplyOptions["withCommandNativeSubagents"]>>[0],
  run: (
    create:
      | import("../../plugins/runtime/native-subagent-context.js").NativeSubagentCommandFactory
      | undefined,
  ) => Promise<T>,
): Promise<T> => {
  // Internal/suggested text is not a fresh external command, even if it resembles one.
  const provenance = state.ctx.InputProvenance;
  const replyOptions = state.params.replyOptions;
  if (
    (provenance && provenance.kind !== "external_user") ||
    !replyOptions?.operatorAuthority ||
    binding.agentId !== state.sessionAgentId ||
    binding.sessionKey !== state.sessionKey
  ) {
    return await run(undefined);
  }
  // Gateway chat supplies its run and recorder; channel ingress gets a host-minted pair
  // bound to the same operator authority. Either way, the gate below is unchanged.
  const turn: CommandUserTurn | undefined =
    replyOptions.runId && replyOptions.userTurnTranscriptRecorder
      ? {
          runId: replyOptions.runId,
          userTurnTranscriptRecorder: replyOptions.userTurnTranscriptRecorder,
        }
      : await (async () => {
          /**
           * Gateway chat ingress supplies its own run and recorder. Channel ingress has neither,
           * so the host mints them here, but only for the operator authority that host ingress
           * bound to this verified channel principal. Nothing persists until the gate commits it.
           */
          const params = {
            dispatch: state,
            cfg: state.cfg,
            ctx: state.ctx,
            replyOptions,
            binding,
          };
          const { ctx, replyOptions: turnReplyOptions, binding: turnBinding } = params;
          const operatorAuthority = turnReplyOptions?.operatorAuthority;
          const ownerAuthority = getCommandOwnerAuthority(ctx);
          if (
            turnReplyOptions?.runId !== undefined ||
            turnReplyOptions?.userTurnTranscriptRecorder !== undefined ||
            getGatewayLocalUserIngress(ctx) !== undefined ||
            isInternalMessageChannel(ctx.Provider ?? ctx.Surface) ||
            !operatorAuthority ||
            !ownerAuthority ||
            ownerAuthority.operatorAuthority !== operatorAuthority ||
            !turnBinding.entry.sessionId ||
            !turnBinding.storePath ||
            !turnBinding.commandBody
          ) {
            return undefined;
          }
          const existing = channelTurns.get(params.dispatch);
          if (existing) {
            return existing;
          }
          // Store the same redacted form the channel command transcript already records.
          const text = await prepareCommandTranscriptInput(turnBinding.commandBody);
          if (!text) {
            return undefined;
          }
          const raced = channelTurns.get(params.dispatch);
          if (raced) {
            return raced;
          }
          const senderIsOwner = ownerAuthority.isCurrent();
          const timestamp = normalizeMessageTimestampMs(ctx.Timestamp);
          // Dispatch fixed this route-scoped id before hooks; a continuing agent turn and restart
          // recovery require the same source-keyed admission.
          const sourceTurnId = readChannelSourceTurnId(ctx);
          const persistSender =
            ctx.ChatType === "group" ||
            ctx.ChatType === "channel" ||
            (ctx.InboundAccessAuthorized === true && ctx.SenderIsSelf !== true);
          const preparedTurn: CommandUserTurn = Object.freeze({
            runId: randomUUID(),
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              input: {
                text,
                senderIsOwner,
                requesterOrigin: captureRequesterOrigin({
                  ...resolveInboundReplyToolAuthorityOverlay({
                    ctx,
                    sessionEntry: turnBinding.entry,
                    senderIsOwner,
                    operatorAuthority,
                    disableTools: false,
                  }),
                  sessionKey: turnBinding.sessionKey,
                  operatorProfileId: operatorAuthority.profileId,
                }),
                ...(sourceTurnId ? { idempotencyKey: sourceTurnId } : {}),
                ...(ctx.InputProvenance ? { provenance: ctx.InputProvenance } : {}),
                ...(timestamp ? { timestamp } : {}),
                ...(persistSender ? { sender: buildChannelUserTurnSender(ctx) } : {}),
              },
              target: {
                agentId: turnBinding.agentId,
                sessionKey: turnBinding.sessionKey,
                sessionId: turnBinding.entry.sessionId,
                sessionEntry: turnBinding.entry,
                storePath: turnBinding.storePath,
                config: params.cfg,
              },
              errorContext: "plugin command user turn transcript",
              beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
            }),
          });
          channelTurns.set(params.dispatch, preparedTurn);
          return preparedTurn;
        })();
  if (!turn) {
    return await run(undefined);
  }
  const requester = requesterState(
    {
      ...state,
      sessionAgentId: binding.agentId,
      sessionKey: binding.sessionKey,
      sessionStoreEntry: { sessionKey: binding.sessionKey, entry: binding.entry },
    },
    turn,
  );
  return await withRequesterNativeSubagents(
    {
      ...requester,
      sessionAgentId: binding.agentId,
      sessionKey: binding.sessionKey,
      entry: binding.entry,
      getAbortSignal: () => {
        const signals = [
          state.getDispatchAbortSignal(),
          state.params.replyOptions?.abortSignal,
        ].filter((signal): signal is AbortSignal => signal !== undefined);
        return signals.length ? AbortSignal.any(signals) : undefined;
      },
      ingress: { ...requester.ingress, boundary: "auto-reply.plugin-command" },
      commandIngressEligible: true,
      enableScheduledTurns: true,
    },
    run,
  );
};
