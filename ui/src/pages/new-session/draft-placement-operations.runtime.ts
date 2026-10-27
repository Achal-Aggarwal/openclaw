import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import {
  pauseSessionPlacementRecovery,
  type SessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import { deleteSessionPlacementDraft } from "../../lib/sessions/session-placement-startup.ts";
import { retainCreatedComposer } from "./creation-composer-registry.ts";
import type { CreationComposer } from "./creation-composer.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type {
  DraftSubmissionCallbacks,
  DraftSubmissionSnapshot,
} from "./draft-submission-contract.ts";
import type { PreparedDraftSubmission } from "./draft-submission-input.ts";
import type { PendingSessionPlacementRecoveryState } from "./session-placement-recovery-state.ts";
import type { StartedSessionNavigation } from "./started-session-navigation.ts";

registerNewSessionSetupEnglish();

/** Transfer startup custody before retiring the source draft or navigating. */
export async function completeDraftSessionPlacement(params: {
  context: ApplicationContext;
  input: PreparedDraftSubmission;
  result: SessionCreateOutcome;
  pending: PendingSessionPlacementRecoveryState;
  submittedRecovery: SessionPlacementRecovery;
  requestSignal: AbortSignal;
  gateway: DraftGatewayState;
  read: () => DraftSubmissionSnapshot;
  getComposer: () => CreationComposer | undefined;
  retainSubmittedSession: ReturnType<StartedSessionNavigation["captureSubmission"]>;
  clearRecovery: () => void;
  setError: (error: string) => void;
  onRecoveryUnavailable: (error: string) => void;
  clearDraft: () => Promise<void>;
  onAccepted: DraftSubmissionCallbacks["onAccepted"];
  navigation: StartedSessionNavigation;
}) {
  const { pending, submittedRecovery, input, result, requestSignal } = params;
  const sessionKey = result.key;
  const isLifecycleCurrent = () =>
    params.read().isConnected &&
    input.client.recoveryScopeReady &&
    !requestSignal.aborted &&
    params.gateway.client === input.client &&
    params.gateway.gatewayUrl === input.gatewayUrl &&
    params.gateway.recoveryScope === input.recoveryScope;
  const recoveryUnavailable = () =>
    params.onRecoveryUnavailable(
      t("newSession.placementStartFailed", {
        error: "placement recovery storage is unavailable",
      }),
    );
  const { gatewayUrl, recoveryScope } = submittedRecovery;
  const ownsRecovery = (key: string) => pending.owns(gatewayUrl, recoveryScope, key);
  const ownsSubmissionRecovery = () => ownsRecovery(submittedRecovery.sessionKey);
  if (
    submittedRecovery.phase === "creating" &&
    (!isLifecycleCurrent() || !ownsSubmissionRecovery())
  ) {
    // A remounted surface can claim the same idempotent creating record.
    // Its live retry, not this departed submitter, now owns settlement.
    if (pending.hasOtherLiveOwner(gatewayUrl, recoveryScope, submittedRecovery.sessionKey)) {
      return;
    }
    const cleanupError = await deleteSessionPlacementDraft(
      { client: input.client, describe: params.context.sessions.describe },
      sessionKey,
      input.agentId,
    );
    if (cleanupError) {
      if (ownsSubmissionRecovery()) {
        pending.promoteToDispatching(sessionKey);
        pending.retryAllowed = true;
      }
      params.setError(t("newSession.placementStartFailed", { error: cleanupError }));
    } else if (ownsSubmissionRecovery()) {
      params.clearRecovery();
    }
    return;
  }
  if (
    submittedRecovery.phase === "creating" &&
    isLifecycleCurrent() &&
    ownsSubmissionRecovery() &&
    !pending.promoteToDispatching(sessionKey)
  ) {
    recoveryUnavailable();
    return;
  }
  const captured = pending.capture();
  if (!captured || captured.phase === "creating") {
    recoveryUnavailable();
    return;
  }
  if (requestSignal.aborted) {
    return;
  }
  const startupError =
    result.initialRun.status === "rejected" ? result.initialRun.error : undefined;
  const recovery = startupError
    ? pauseSessionPlacementRecovery(captured, startupError, pending.persistent).recovery
    : captured;
  params.context.placementStartup.start({
    recovery,
    persistRecovery: pending.persistent,
    mode: submittedRecovery.phase === "creating" ? "dispatch" : "recover",
    createdAt: input.turn.createdAt,
  });
  await input.consumeWorktreeName?.();
  const ownsStartedPlacement = () => isLifecycleCurrent() && ownsRecovery(recovery.sessionKey);
  if (!ownsStartedPlacement()) {
    return;
  }
  const composer = params.getComposer();
  if (composer) {
    composer.accept(result);
    retainCreatedComposer(params.context, sessionKey, composer);
  }
  params.retainSubmittedSession(sessionKey);
  await params.clearDraft();
  if (!ownsStartedPlacement()) {
    return;
  }
  pending.reset();
  if (input.completeInBackground(recovery.sessionKey, recovery.messageId)) {
    params.onAccepted?.({ ...result, agentId: input.agentId });
    return;
  }
  await params.navigation.navigate(params.context, {
    client: input.client,
    key: sessionKey,
    agentId: input.agentId,
  });
}
