import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import {
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "../../../../packages/gateway-protocol/src/restart-unavailable.ts";
import { isNonTerminalAgentRunStatus } from "../../../../src/shared/agent-run-status.js";
import { GatewayPayloadLimitError } from "../../api/gateway-browser-socket.ts";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  sameQueuedDeliveryVersion,
} from "../../lib/chat/outbox-store-codec.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { chatOutboxDeliveryKey, storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { isAgentRuntimeRestrictionErrorDetails } from "../../lib/protocol-validators.generated/session-input.js";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/navigation.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { discardChatAttachmentDataUrls } from "./attachment-payload-store.ts";
import { readChatResetTargetAccess } from "./chat-commands.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { loadChatBranches } from "./chat-history-branches.ts";
import { setChatError } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { captureChatNativeRuntimeRecovery } from "./chat-model-recovery.runtime.ts";
import {
  flushStoredChatOutbox,
  scheduleStoredChatOutboxRetry,
  type QueuedChatSendOptions,
  type QueuedChatSendResult,
} from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { CHAT_OUTBOX_RETRY_DEFAULT_MS, retryableGatewayDelayMs } from "./chat-outbox-retry.ts";
import {
  excludeComposerAttachments,
  readQueuedMessageById,
  updateQueuedMessage,
} from "./chat-queue.ts";
import {
  formatTerminalChatSendAckError,
  isTerminalFailureChatSendAck,
  isActiveLeafChangedError,
} from "./chat-send-ack.ts";
import { restoreRejectedChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, sendQueuedChatMessage } from "./chat-send-delivery.ts";
import {
  deliveryStateWriter,
  updateQueuedSendItem,
  finishChatDeliveryAdmission,
  settleDeliverySettings,
} from "./chat-send-queue-state.ts";
import { requestChatSend } from "./chat-send-request.ts";
import {
  surfaceChatDeliveryFailure,
  OFFLINE_QUEUE_STORAGE_ERROR,
  retireDeliveredQueuedUserTurn,
} from "./chat-send-support.ts";
import { refreshChatSessionListForTarget } from "./chat-session.ts";
import { attachmentBatchRejection } from "./components/chat-attachment-admission.ts";
import { formatConnectError } from "./connect-error.ts";
import { readChatSessionProjectionScope, reduceChatSessionProjection } from "./history-merge.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

function finishScopedChatSending(host: ChatHost, scope: StoredChatOutboxScope): void {
  if (host.chatSendingScopeKey !== storedChatOutboxScopeKey(scope)) {
    return;
  }
  host.chatSendingScopeKey = null;
  host.chatSending = false;
}

async function prepareQueuedChatPayload(
  host: ChatHost,
  queued: ChatQueueItem,
  queuedSessionKey: string,
): Promise<ChatQueueItem | QueuedChatSendResult> {
  const id = queued.id;
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const sessionKey = queued.sessionKey ?? queuedSessionKey;
  const ownerIsCurrent = captureOutboxPayloadOwner(
    host,
    resolveUiConversationIdentity(host, sessionKey, queued.agentId),
  );
  const payload = await prepareOutboxPayload(host, { ...queued, sessionKey });
  const current = readQueuedMessageById(host, id);
  if (
    !connectionIsCurrent() ||
    !ownerIsCurrent() ||
    !current ||
    !sameQueuedDeliveryVersion(current, queued) ||
    isQueuedMessageBeingEdited(host, id)
  ) {
    if (payload.status === "ready" && !queued.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  if (payload.status === "failed") {
    const failed = failOutboxPayload(current, payload.reason);
    updateQueuedMessage(host, id, () => failed);
    surfaceChatDeliveryFailure(host, sessionKey, queued.agentId, failed.sendError);
    return "failed";
  }
  const hydrated = { ...queued, ...payload.update };
  if (
    (!queued.attachmentPayload || queued.attachmentStorageError) &&
    !updateQueuedMessage(host, id, () => hydrated)
  ) {
    if (!queued.attachmentPayload) {
      retireOutboxPayload(payload.update);
    }
    return "pending";
  }
  return hydrated;
}

export { chatOutboxDrainDependencies } from "./chat-send-delivery.ts";

export async function sendPreparedChatQueueItem(
  host: ChatHost,
  preparedItem: ChatQueueItem,
  expectedLeafEntryId: string | null | undefined,
  options: QueuedChatSendOptions | undefined,
  queuedSessionKey: string,
  allowNativeRecovery: boolean,
  retryOwnerIsCurrent: () => boolean,
): Promise<QueuedChatSendResult> {
  let queued = preparedItem;
  const id = queued.id;
  const storageMode = options?.storageMode ?? "durable";
  const approvedReset = queued.localCommandName === "reset" && Boolean(options?.target);
  if (
    storageMode === "durable" &&
    (queued.attachments?.length || queued.attachmentPayload || queued.attachmentStorageError)
  ) {
    const prepared = await prepareQueuedChatPayload(host, queued, queuedSessionKey);
    if (!retryOwnerIsCurrent()) {
      return "failed";
    }
    if (typeof prepared === "string") {
      return prepared;
    }
    queued = prepared;
  }
  return settleDeliverySettings(
    host,
    queued,
    storageMode,
    queued.sessionKey ?? queuedSessionKey,
    options,
    async (settledItem) => {
      if (!retryOwnerIsCurrent()) {
        return "failed";
      }
      const queueSessionKey = queued.sessionKey ?? queuedSessionKey;
      const route = options?.routingSessionKey ?? queueSessionKey;
      let prepared = finishChatDeliveryAdmission(
        host,
        settledItem,
        storageMode,
        queueSessionKey,
        options,
      );
      if (typeof prepared !== "string" && queued.attachmentPayload) {
        prepared = { ...prepared, attachments: queued.attachments };
      }
      if (typeof prepared === "string") {
        return prepared;
      }
      if (!prepared.sendRunId || !prepared.sendState) {
        const sessionKey = prepared.sessionKey ?? queuedSessionKey;
        prepared =
          updateQueuedSendItem(host, storageMode, prepared.id, (item) => ({
            ...item,
            sendAttempts: item.sendAttempts ?? 0,
            sendRunId: item.sendRunId ?? generateUUID(),
            sendState: host.connected && host.client ? "sending" : "waiting-reconnect",
            sessionKey,
            agentId: item.agentId ?? scopedAgentIdForSession(host, sessionKey),
          })) ?? "pending";
      }
      if (typeof prepared === "string") {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return prepared;
      }
      if (approvedReset) {
        prepared = {
          ...prepared,
          refreshSessions: true,
          text: prepared.localCommandArgs ? `/reset ${prepared.localCommandArgs}` : "/reset",
        };
      }
      const submitted = trimHumanMentions(prepared.text, prepared.mentions);
      const message = prepared.intent ? prepared.text : submitted.text;
      const attachments =
        (queued.attachmentPayload ? queued.attachments : prepared.attachments) ?? [];
      if (!message && attachments.length === 0) {
        chatOutboxOwner(host).remove(host, id);
        return "sent";
      }
      const sessionKey = prepared.sessionKey ?? host.sessionKey;
      const setState = deliveryStateWriter(host, storageMode, id);
      if (options?.target) {
        const access = readChatResetTargetAccess(host, options.target);
        if (!access.allowed) {
          setState("failed", access.reason);
          surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, access.reason);
          return "failed";
        }
      }
      if (!host.connected || !host.client) {
        const waiting = setState("waiting-reconnect");
        if (!waiting && restoreRejectedChatDelivery(host, prepared, options)) {
          return "failed";
        }
        if (!waiting) {
          setState("failed", OFFLINE_QUEUE_STORAGE_ERROR);
          surfaceChatDeliveryFailure(
            host,
            sessionKey,
            prepared.agentId,
            OFFLINE_QUEUE_STORAGE_ERROR,
          );
        }
        return "pending";
      }

      const attachmentError = attachmentBatchRejection(attachments, host.hello?.policy);
      if (attachmentError !== undefined) {
        if (!restoreRejectedChatDelivery(host, prepared, options)) {
          setState("failed", attachmentError);
        }
        surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, attachmentError);
        return "failed";
      }

      const requestConnectionIsCurrent = captureChatConnectionOwner(host);
      const runId = prepared.sendRunId ?? generateUUID();
      const startedAt = Date.now();
      const requestStartedAtMs = performance.now();
      const sendingItem = updateQueuedSendItem(host, storageMode, id, (item) => ({
        ...item,
        sendAttempts: (item.sendAttempts ?? 0) + 1,
        sendError: undefined,
        sendRunId: runId,
        sendState: "sending",
        sendRequestStartedAtMs: requestStartedAtMs,
        sessionKey,
        // A reconnect must not replay an old attempt into a replacement session.
        sessionId:
          item.sessionId ??
          (visibleSessionMatches(host, sessionKey, prepared.agentId)
            ? (host.currentSessionId ?? undefined)
            : undefined),
        agentId: prepared.agentId,
      }));
      if (!sendingItem) {
        surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, OFFLINE_QUEUE_STORAGE_ERROR);
        return "pending";
      }
      const scope = {
        sessionKey,
        ...(prepared.agentId ? { agentId: prepared.agentId } : {}),
      };
      const isVisible = () => visibleSessionMatches(host, sessionKey, prepared.agentId);
      const recoverNativeRuntime =
        allowNativeRecovery && isVisible()
          ? captureChatNativeRuntimeRecovery(host, route)
          : undefined;
      let steerSubmission: ReturnType<ChatHost["chatSubmissions"]["retain"]>;
      const buildSubmittedUserMessage = (steerTargetRunId?: string) =>
        buildLocalUserMessage(
          {
            ...prepared,
            text: message,
            mentions: submitted.mentions,
            attachments,
            createdAt: startedAt,
            runId,
            ...(steerTargetRunId ? { steerTargetRunId } : {}),
          },
          "complete",
        );
      if (isVisible()) {
        host.chatSendingScopeKey = storedChatOutboxScopeKey(scope);
        host.chatSending = true;
        // Keep the current run intact until an ACK or live event owns its replacement.
        if (!host.chatRunId) {
          resetToolStream(host);
          host.providerPolicyNotice = null;
        }
        setChatError(host, null);
        reconcileChatRunLifecycle(host, {
          clearRunStatus: true,
          // A send has not replaced the active run; its progress and approvals still belong to it.
          clearIndicators: !host.chatRunId,
        });
      }

      try {
        if (options?.canDispatch && !options.canDispatch()) {
          setState("failed", INTERRUPTED_SETTINGS_WAIT_ERROR);
          surfaceChatDeliveryFailure(
            host,
            sessionKey,
            prepared.agentId,
            INTERRUPTED_SETTINGS_WAIT_ERROR,
          );
          return "failed";
        }
        const deliveryLeafEntryId = prepared.intent
          ? prepared.expectedLeafEntryId
          : expectedLeafEntryId === undefined && sendingItem.sessionId
            ? null
            : expectedLeafEntryId;
        if (prepared.queueMode === "steer" && isVisible() && host.chatRunId) {
          const steerTargetRunId = host.chatRunId;
          const projectedMessage = buildSubmittedUserMessage(steerTargetRunId);
          if (projectedMessage) {
            steerSubmission = host.chatSubmissions.retain({
              kind: "delivered",
              deliveryKey: chatOutboxDeliveryKey(host, scope, runId),
              owner: host.client!,
              sessionKey,
              agentId: prepared.agentId,
              sessionId: prepared.sessionId ?? host.currentSessionId ?? undefined,
              pendingRunId: runId,
              message: projectedMessage,
            });
            reduceChatSessionProjection(
              host,
              { type: "sendPending", runId, message: projectedMessage },
              {
                scope: readChatSessionProjectionScope(host, {
                  sessionKey,
                  agentId: prepared.agentId,
                }),
              },
            );
          }
        }
        const ack = await requestChatSend(host, {
          message,
          workContext: prepared.workContext,
          mentions: submitted.mentions,
          attachments: attachments.length ? attachments : undefined,
          runId,
          sessionKey,
          agentId: prepared.agentId,
          ...(sendingItem.sessionId ? { sessionId: sendingItem.sessionId } : {}),
          ...(prepared.intent ? { intent: prepared.intent, sessionId: prepared.sessionId } : {}),
          ...(prepared.queueMode ? { queueMode: prepared.queueMode } : {}),
          ...(prepared.queueMode !== "steer" && deliveryLeafEntryId !== undefined
            ? { expectedLeafEntryId: deliveryLeafEntryId }
            : {}),
          ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
        });
        if (!requestConnectionIsCurrent()) {
          return "pending";
        }
        if (isTerminalFailureChatSendAck(ack)) {
          if (ack.stopReason === "restart" && storageMode === "durable") {
            setState("waiting-reconnect");
            return "pending";
          }
          const error = formatTerminalChatSendAckError(ack, "chat");
          if (steerSubmission) {
            steerSubmission.pending = false;
          }
          // Release in-flight ownership before publishing Retry; an immediate click
          // must not see this completed send as the run that blocks its replacement.
          finishScopedChatSending(host, scope);
          const restoreCommand =
            options?.restoreOnTerminalFailure === true &&
            restoreRejectedChatDelivery(host, prepared, options);
          if (!restoreCommand) {
            setState("failed", error);
          }
          if (isVisible()) {
            const projectionScope = readChatSessionProjectionScope(host, {
              sessionKey,
              agentId: prepared.agentId,
            });
            reduceChatSessionProjection(
              host,
              { type: "sendFailed", runId },
              { scope: projectionScope },
            );
            const ownsLocalRun = host.chatRunId === ack.runId;
            reconcileChatRunLifecycle(host, {
              outcome: "interrupted",
              sessionStatus: ack.status === "error" ? "failed" : "killed",
              runId: ack.runId,
              sessionKey,
              clearIndicators: ownsLocalRun,
              clearLocalRun: ownsLocalRun,
              clearToolStream: ownsLocalRun,
              publishRunStatus: false,
              armLocalTerminalReconcile: (!host.chatRunId || ownsLocalRun) && ack.runId === runId,
            });
          }
          surfaceChatDeliveryFailure(host, sessionKey, prepared.agentId, error, {
            inline: storageMode === "durable" && !restoreCommand,
          });
          return "failed";
        }
        // Publish accepted run activity before retiring its queued progress across an await.
        // Steering keeps the active run; only an explicit interrupt replaces it here.
        if (
          isNonTerminalAgentRunStatus(ack.status) &&
          isVisible() &&
          (!host.chatRunId || prepared.queueMode === "interrupt")
        ) {
          adoptStartedChatRun(host, ack.runId, startedAt);
        }
        // Durable delivery hands complete display bytes to the existing shared owner.
        // Memory-only admission has no stored row and retains its local projection.
        const inputConsumed = ack.status === "ok" && ack.messageSeq !== undefined;
        const projectedMessage =
          storageMode === "memory" && !inputConsumed ? buildSubmittedUserMessage() : null;
        if (storageMode === "durable" || inputConsumed) {
          const retirement = await retireDeliveredQueuedUserTurn(host, runId, scope, {
            inputConsumed,
          });
          if (retirement === "stale" || !requestConnectionIsCurrent()) {
            return "pending";
          }
          // A peer may have retired durable custody while this pane still displays its local row.
          chatOutboxOwner(host).syncHost(host);
        }
        if (storageMode === "memory") {
          chatOutboxOwner(host).remove(host, id);
        }
        const retirementFailed =
          storageMode === "durable" && readQueuedMessageById(host, id) !== null;
        if (isVisible()) {
          const projectionScope = readChatSessionProjectionScope(host, {
            sessionKey,
            agentId: prepared.agentId,
          });
          if (projectedMessage) {
            reduceChatSessionProjection(
              host,
              { type: "sendPending", runId, message: projectedMessage },
              { scope: projectionScope },
            );
          }
          if (ack.runId !== runId) {
            reduceChatSessionProjection(
              host,
              { type: "sendAcknowledged", previousRunId: runId, runId: ack.runId },
              { scope: projectionScope },
            );
          }
          if (ack.status === "ok") {
            // A replayed input receipt does not complete another run in this session.
            const ownsLocalRun = host.chatRunId === ack.runId;
            reconcileChatRunLifecycle(host, {
              outcome: "done",
              sessionStatus: "done",
              runId: ack.runId,
              sessionKey,
              clearIndicators: ownsLocalRun,
              clearLocalRun: ownsLocalRun,
              clearToolStreamForRun: true,
              publishRunStatus: false,
              armLocalTerminalReconcile: (!host.chatRunId || ownsLocalRun) && ack.runId === runId,
            });
            void loadChatHistory(host).then(() =>
              flushStoredChatOutbox(host, chatOutboxDrainDependencies),
            );
          } else if (isNonTerminalAgentRunStatus(ack.status)) {
            // Hydrate approved custody during setup without changing ordinary send
            // reconciliation or steering, whose ACK does not identify a new input.
            const setupHeld =
              prepared.sessionId &&
              host.sessionsResult?.sessions.some(
                (row) =>
                  row.sessionId === prepared.sessionId &&
                  ["requested", "provisioning", "syncing", "starting"].includes(
                    row.placement?.state ?? "",
                  ),
              );
            if (prepared.queueMode !== "steer" && ack.messageSeq === undefined && setupHeld) {
              void loadChatHistory(host, { deferBranches: true });
            }
          }
        }
        if (prepared.refreshSessions) {
          const target = { sessionKey, agentId: prepared.agentId };
          if (ack.status === "ok") {
            void refreshChatSessionListForTarget(host, target);
          } else if (isNonTerminalAgentRunStatus(ack.status)) {
            host.refreshSessionsAfterChat.set(ack.runId, target);
          }
        }
        discardChatAttachmentDataUrls(excludeComposerAttachments(host, attachments));
        if (retirementFailed) {
          surfaceChatDeliveryFailure(
            host,
            sessionKey,
            prepared.agentId,
            OFFLINE_QUEUE_STORAGE_ERROR,
          );
          return "pending";
        }
        return "sent";
      } catch (err) {
        if (!requestConnectionIsCurrent()) {
          return "pending";
        }
        if (steerSubmission) {
          steerSubmission.pending = false;
        }
        if (prepared.queueMode === "steer" && isVisible()) {
          // The retained outbox row owns pending and rejected-delivery feedback.
          reduceChatSessionProjection(
            host,
            { type: "sendFailed", runId },
            {
              scope: readChatSessionProjectionScope(host, {
                sessionKey,
                agentId: prepared.agentId,
              }),
            },
          );
        }
        const restriction =
          err instanceof GatewayRequestError && isAgentRuntimeRestrictionErrorDetails(err.details)
            ? err.details
            : undefined;
        if (restriction) {
          const error = formatConnectError(err);
          // Keep the exact outbox input through confirmation; never retry a newer draft.
          finishScopedChatSending(host, scope);
          const failed = setState("failed", error);
          const canRetry = allowNativeRecovery
            ? await recoverNativeRuntime?.(restriction)
            : undefined;
          if (canRetry?.() && requestConnectionIsCurrent() && isVisible()) {
            const current = readQueuedMessageById(host, id);
            if (!failed || !current || !sameQueuedDeliveryVersion(failed, current)) {
              return "failed";
            }
            const retry = updateQueuedSendItem(host, storageMode, id, (item) => ({
              ...item,
              sendRunId: generateUUID(),
              sendError: undefined,
              sessionId: restriction.recovery?.sessionId,
              sendState: "sending",
            }));
            if (retry) {
              return await sendQueuedChatMessage(
                host,
                id,
                { ...options, canDispatch: canRetry, allowActiveRunSend: true },
                queuedSessionKey,
                false,
              );
            }
          }
          const restored = restoreRejectedChatDelivery(host, prepared, options);
          surfaceChatDeliveryFailure(
            host,
            sessionKey,
            prepared.agentId,
            (isVisible() && host.chatError) || error,
            { inline: storageMode === "durable" && !restored },
          );
          return "failed";
        }
        /** Keep ambiguous transport outcomes pending under their original admission key. */
        {
          const scheduleRetry = (retryDelayMs: number) =>
            scheduleStoredChatOutboxRetry(host, scope, retryDelayMs, chatOutboxDrainDependencies);
          const failedId = prepared.id;
          const { sessionKey: failedKey } = scope;
          const mode = options?.storageMode ?? "durable";
          const writeState = deliveryStateWriter(host, mode, failedId);
          const activeLeafChanged = isActiveLeafChangedError(err);
          const error = activeLeafChanged
            ? t("chat.sendErrors.activeLeafChanged")
            : formatConnectError(err);
          const reportFailure = (detail = error, display?: { inline?: boolean }) => {
            surfaceChatDeliveryFailure(host, failedKey, prepared.agentId, detail, display);
          };
          // A review can hold an already-dispatched request. Its later failure cannot
          // restore passive retry authority, even after the provider pause has cleared.
          if (readQueuedMessageById(host, failedId)?.sendState === "held") {
            return "pending";
          }
          if (err instanceof GatewayPayloadLimitError) {
            if (!restoreRejectedChatDelivery(host, prepared, options)) {
              writeState("failed", error);
            }
            reportFailure();
            return "failed";
          }
          if (err instanceof GatewayProtocolRequestTimeoutError && err.requestSent) {
            // Admission deduplicates recorded input. Reconnect can resend this exact key.
            finishScopedChatSending(host, scope);
            // A live receipt or another pane can retire this row before the ACK deadline.
            // Missing custody is not a failed storage write, and must not resurrect it.
            if (!readQueuedMessageById(host, failedId)) {
              return "pending";
            }
            const retained = writeState("waiting-reconnect");
            if (!retained) {
              reportFailure(OFFLINE_QUEUE_STORAGE_ERROR);
            }
            if (retained) {
              scheduleRetry(CHAT_OUTBOX_RETRY_DEFAULT_MS);
            }
            return "pending";
          }
          const recoverable =
            !activeLeafChanged &&
            (err instanceof GatewayRequestError
              ? err.retryable
              : /gateway (?:not connected|closed)|websocket|disconnected/i.test(error));
          if (recoverable) {
            const failedBeforeTransport =
              err instanceof Error &&
              !(err instanceof GatewayRequestError) &&
              err.message === "gateway not connected";
            const retryDelayMs = retryableGatewayDelayMs(err);
            const safelyRejected = failedBeforeTransport || retryDelayMs !== null;
            const rollbackAttempt = safelyRejected
              ? {
                  sendAttempts: queued.sendAttempts,
                  sendRequestStartedAtMs: queued.sendRequestStartedAtMs,
                }
              : {};
            if (mode === "memory") {
              const restore =
                failedBeforeTransport && restoreRejectedChatDelivery(host, prepared, options);
              if (!restore) {
                const waiting = updateQueuedSendItem(host, mode, failedId, (item) => ({
                  ...item,
                  ...rollbackAttempt,
                  sendError: undefined,
                  sendState: "waiting-reconnect",
                }));
                if (waiting && retryDelayMs !== null) {
                  scheduleRetry(retryDelayMs);
                }
              }
              if (restore) {
                reportFailure(error);
              }
              return restore ? "failed" : "pending";
            }
            const awaitingGateway =
              isGatewayRestartUnavailableError(err) || isGatewaySuspendUnavailableError(err);
            const waiting = updateQueuedMessage(host, failedId, (item) => ({
              ...item,
              ...rollbackAttempt,
              sendError: awaitingGateway ? undefined : error,
              sendState: "waiting-reconnect",
            }));
            if (!waiting) {
              const restore =
                failedBeforeTransport && restoreRejectedChatDelivery(host, prepared, options);
              if (!restore) {
                updateQueuedMessage(host, failedId, (item) => ({
                  ...item,
                  sendError: OFFLINE_QUEUE_STORAGE_ERROR,
                  sendState: "failed",
                }));
              }
              reportFailure(OFFLINE_QUEUE_STORAGE_ERROR);
              return restore ? "failed" : "pending";
            }
            if (!awaitingGateway && visibleSessionMatches(host, failedKey, prepared.agentId)) {
              setChatError(
                host,
                retryDelayMs === null
                  ? "Message will send when the Gateway reconnects."
                  : "The Gateway asked us to retry this message shortly.",
              );
            }
            if (retryDelayMs !== null) {
              scheduleRetry(retryDelayMs);
            }
            return "pending";
          }
          // Release the completed send before exposing its Retry action.
          finishScopedChatSending(host, scope);
          const restoreCommand =
            options?.restoreOnTerminalFailure === true &&
            restoreRejectedChatDelivery(host, prepared, options);
          if (!restoreCommand) {
            writeState("failed", error);
          }
          if (visibleSessionMatches(host, failedKey, prepared.agentId) && activeLeafChanged) {
            void Promise.all([loadChatHistory(host), loadChatBranches(host)]);
          }
          reportFailure(error, { inline: mode === "durable" && !restoreCommand });
          return "failed";
        }
      } finally {
        if (requestConnectionIsCurrent()) {
          finishScopedChatSending(host, scope);
        }
      }
    },
  );
}
