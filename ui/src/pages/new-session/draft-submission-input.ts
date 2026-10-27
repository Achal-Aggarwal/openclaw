import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import { attachmentBatchRejection } from "../chat/components/chat-attachment-admission.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftStartupResumption } from "./draft-session-startup.ts";
import type { DraftSubmissionSnapshot } from "./draft-submission-contract.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";
import { readNewSessionSubmissionAccess } from "./submit-gates.ts";

/** Freeze the selected or recovered input before creation can yield to another draft. */
export function prepareDraftSubmission(
  context: ApplicationContext,
  draft: {
    message: string;
    mentions: readonly HumanMention[];
    attachmentDraft: { attachments: ChatAttachment[] };
    pendingPlacement: PendingSessionPlacementRecoveryState;
    visibility: NewSessionVisibility;
  },
  place: DraftPlaceState,
  startup?: DraftStartupResumption,
  background = false,
) {
  const pending = draft.pendingPlacement;
  if (
    !uploadsEnabled(context.config) &&
    (draft.attachmentDraft.attachments.length ||
      pending.attachments?.length ||
      startup?.params.attachments?.length)
  ) {
    return { kind: "uploads-disabled" as const, error: uploadsDisabledMessage() };
  }
  if (startup) {
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params: startup.params,
      sessionScope: true,
    });
    if (!access.allowed) {
      return { kind: "startup-access-denied" as const, error: access.reason };
    }
  }
  const pendingPlacement = !startup && Boolean(pending.sessionKey);
  const submitted = trimHumanMentions(draft.message, draft.mentions);
  const message = startup?.params.message ?? (pendingPlacement ? pending.message : submitted.text);
  const mentions = (
    startup ? startup.params.mentions : pendingPlacement ? pending.mentions : submitted.mentions
  )?.map(({ profileId, start, end }) => ({ profileId, start, end }));
  const attachments = draft.attachmentDraft.attachments;
  if (!startup && !pendingPlacement) {
    const error = attachmentBatchRejection(attachments, context.gateway.snapshot.hello?.policy);
    if (error !== undefined) {
      showToast({ message: error });
      return null;
    }
  }
  const draftAttachments = startup
    ? startup.params.attachments
    : pendingPlacement
      ? undefined
      : buildChatApiAttachments(attachments);
  const apiAttachments = pendingPlacement ? pending.attachments : draftAttachments;
  const submissionAgentId =
    startup?.params.agentId ??
    (pendingPlacement ? pending.agentId : normalizeAgentId(place.agentId));
  const gatewayUrl = pendingPlacement ? pending.gatewayUrl : context.gateway.connection.gatewayUrl;
  const client = context.gateway.snapshot.client;
  if (!client || !context.gateway.snapshot.hello) {
    return null;
  }
  if (!startup && !pendingPlacement) {
    place.modelControl.initializeAccessProgram();
  }
  const completeInBackground = prepareBackgroundSessionCompletion({
    enabled: background,
    agentId: submissionAgentId,
    client,
    context,
  });
  const recoveryScope = pendingPlacement ? pending.recoveryScope : client.recoveryScope;
  const submittedPlacement =
    startup?.params ??
    (pendingPlacement
      ? pending.createParams
      : buildSelectedSessionCreateParams(place, { message, visibility: draft.visibility }));
  const { hello, selfUser } = context.gateway.snapshot;
  return {
    kind: "prepared" as const,
    turn: {
      text: message,
      mentions,
      attachments,
      createdAt: startup?.startedAt ?? Date.now(),
      sender: resolveCurrentUserIdentity(hello, client.instanceId, selfUser) ?? undefined,
    },
    consumeWorktreeName:
      submittedPlacement &&
      place.captureSubmittedWorktreeName(
        submittedPlacement,
        submissionAgentId,
        Boolean(startup || pendingPlacement),
      ),
    pendingPlacement,
    message,
    mentions,
    attachments,
    draftAttachments,
    apiAttachments,
    agentId: submissionAgentId,
    gatewayUrl,
    client,
    recoveryScope,
    completeInBackground,
    hasInitialTurn: Boolean(message || apiAttachments?.length),
  };
}

export type PreparedDraftSubmission = Extract<
  NonNullable<ReturnType<typeof prepareDraftSubmission>>,
  { kind: "prepared" }
>;

/** Recheck the captured connection and current permission before preparation writes. */
export function readPreparedDraftSubmissionAccess(options: {
  context: ApplicationContext;
  gateway: DraftGatewayState;
  read: () => DraftSubmissionSnapshot;
  input: PreparedDraftSubmission;
  requestSignal: AbortSignal;
  helloRecoveryScope: string | undefined;
  draftRecoveryScope: string;
  place: DraftPlaceState;
  pending: PendingSessionPlacementRecoveryState;
  startup: DraftStartupResumption | undefined;
  createParams: () => Record<string, unknown>;
}): SessionMethodAccess | null {
  const { context, gateway, input, requestSignal } = options;
  if (
    requestSignal.aborted ||
    !options.read().isConnected ||
    options.read().context !== context ||
    context.gateway.snapshot.client !== input.client ||
    context.gateway.connection.gatewayUrl !== input.gatewayUrl ||
    context.gateway.snapshot.hello?.auth?.recoveryScope !== options.helloRecoveryScope ||
    input.client.recoveryScope !== input.recoveryScope ||
    gateway.client !== input.client ||
    gateway.gatewayUrl !== input.gatewayUrl ||
    gateway.recoveryScope !== options.draftRecoveryScope
  ) {
    return null;
  }
  // In particular, projects.add must use authority current after the import.
  return options.startup
    ? readSessionMethodAccess(context.gateway.snapshot, {
        method: "sessions.create",
        params: options.startup.params,
        sessionScope: true,
      })
    : readNewSessionSubmissionAccess({
        gateway: context.gateway.snapshot,
        place: options.place,
        pendingPlacement: options.pending,
        hasInitialTurn: input.hasInitialTurn,
        createParams: options.pending.createParams ?? options.createParams(),
      });
}
