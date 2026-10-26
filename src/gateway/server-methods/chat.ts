import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateChatPendingInputsDismissParams,
  validateChatInjectParams,
  validateChatToolTitlesParams,
  type ChatInjectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_INPUT_RUN_ID_MAX_CHARS } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { dismissRetiredSessionPendingInputs } from "../../config/sessions/session-pending-input-withdrawal.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { injectGatewayAssistantMessage } from "./chat-inject.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { chatPredictionHandlers } from "./chat-prediction-handler.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const METHOD = "chat.pendingInputs.dismiss";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  ...chatPredictionHandlers,
  [METHOD]: async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationAuthorization,
    sessionAccessAuthority,
  }) => {
    if (!assertValidParams(params, validateChatPendingInputsDismissParams, METHOD, respond)) {
      return;
    }
    if (!sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Dismissing pending inputs requires session write access.",
        ),
      );
      return;
    }
    const target = sessionAccessAuthority.target;
    const staleTarget = () =>
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The conversation changed before pending inputs were dismissed; reload and retry.",
        ),
      );
    if (params.sessionId !== target.sessionId) {
      staleTarget();
      return;
    }
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    try {
      selection = await prepareChatHistorySessionRead({
        context,
        client,
        respond,
        signal,
        sessionMutationAuthorization,
        method: METHOD,
        sessionKey: params.sessionKey,
        agentIdOverride: params.agentId,
      });
      if (!selection) {
        return;
      }
      const { agentId, canonicalKey, storePath } = selection.selectedSession;
      if (
        agentId !== target.agentId ||
        canonicalKey !== target.sessionKey ||
        selection.entry?.sessionId !== target.sessionId
      ) {
        staleTarget();
        return;
      }
      const outcome = await dismissRetiredSessionPendingInputs(
        { agentId, sessionKey: canonicalKey, sessionId: target.sessionId, storePath },
        params.inputIds,
        () => {
          signal?.throwIfAborted();
          sessionAccessAuthority.assertCurrent();
        },
      );
      if (outcome.kind === "stale") {
        staleTarget();
        return;
      }
      if (outcome.kind === "active") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Only interrupted or cancelled pending inputs can be dismissed; queued and running inputs stay in place.",
            {
              details: {
                code: GatewayErrorDetailCodes.PENDING_INPUT_NOT_RETIRED,
                inputIds: outcome.inputIds,
              },
            },
          ),
        );
        return;
      }
      if (outcome.inputIds.length) {
        emitSessionsChanged(
          context,
          {
            sessionKey: canonicalKey,
            sessionId: target.sessionId,
            agentId,
            reason: "agent.input.settled",
          },
          { accessChanged: false },
        );
      }
      respond(true, {
        dismissedIds: outcome.inputIds,
        runIds: outcome.runIds.filter((runId) => runId.length <= CHAT_INPUT_RUN_ID_MAX_CHARS),
        missingIds: outcome.missingIds,
      });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    } finally {
      selection?.release();
    }
  },
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.inject": async (options) => {
    const { params, respond, sessionMutationCommitGuard } = options;
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    if (!isIncognitoSessionKey(params.sessionKey)) {
      return injectChat(options, params);
    }
    const assertCurrent = () => sessionMutationCommitGuard?.();
    const binding = await acquireSessionActorStorage(
      { sessionKey: params.sessionKey, agentId: normalizeOptionalString(params.agentId) },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize: assertCurrent },
      },
    );
    if (!binding) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    try {
      await runWithSessionActorStorage(binding, () => injectChat(options, params));
    } finally {
      await binding.actor.release();
    }
  },
};

async function injectChat(
  { respond, context, sessionMutationCommitGuard }: GatewayRequestHandlerOptions,
  params: ChatInjectParams,
): Promise<void> {
  const result = await injectGatewayAssistantMessage(
    context,
    {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      message: params.message,
      label: params.label,
    },
    sessionMutationCommitGuard,
  );
  if (result.ok) {
    respond(true, { ok: true, messageId: result.value.messageId });
  } else {
    respond(false, undefined, result.error);
  }
}
