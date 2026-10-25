import type { GatewaySessionRow, SessionVisibility } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { ChatPaneSharingActions } from "./chat-pane-sharing-actions.ts";
import type {
  ChatSessionSharingInput,
  ChatSessionSharingProps,
  ChatSessionSharingOutcome,
  PreparedChatSessionSharing,
  PreparedSessionSharingInput,
} from "./components/chat-session-sharing-shared.tsx";

/** The lazy surface supplies code; pending state and authority remain on the pane. */
export type ChatSessionSharingOperationSource = Pick<
  ChatPaneSharingActions,
  | "captureConnectionScope"
  | "currentSessionSharingRow"
  | "ownsHeaderOutcomeScope"
  | "sessionSharingCacheKey"
  | "sessionSharingAgentId"
  | "collaboration"
  | "setSessionSharingState"
  | "sessionSharingHydrationTargets"
  | "loadSessionSharing"
  | "sessionSharingOutcome"
  | "failSharing"
  | "ownsSessionSharing"
>;

export function resolveChatSessionSharing(input: ChatSessionSharingInput): ChatSessionSharingProps {
  return "operations" in input ? resolvePreparedChatSessionSharing(input) : input;
}

export function resolvePreparedChatSessionSharing(
  input: PreparedSessionSharingInput,
): PreparedChatSessionSharing {
  if (!("operations" in input)) return input;
  const { operations: owner, ...presentation } = input;
  return {
    ...presentation,
    onVisibilityChange: (visibility) => mutateSessionSharing(owner, input.session, { visibility }),
    onMemberChange: (identityId, member) =>
      mutateSessionSharing(owner, input.session, { identityId, member }),
    onPublicShareChange: (enabled) => setSessionPublicShare(owner, input.session, enabled),
  };
}

export async function setSessionPublicShare(
  owner: ChatSessionSharingOperationSource,
  row: GatewaySessionRow,
  enabled: boolean,
): Promise<ChatSessionSharingOutcome> {
  const scope = owner.captureConnectionScope();
  const currentRow = scope ? owner.currentSessionSharingRow(scope, row) : null;
  const expectedSessionId = currentRow?.sessionId;
  if (!scope || !currentRow || !expectedSessionId) {
    return { status: "unavailable" };
  }
  const access = () =>
    readSessionMethodAccess(scope.context.gateway.snapshot, {
      method: "session.publicShare.set",
      requiredScope: "operator.write",
    }).allowed;
  const isCurrent = () =>
    owner.ownsHeaderOutcomeScope(scope) &&
    owner.currentSessionSharingRow(scope, currentRow)?.sessionId === expectedSessionId &&
    areUiSessionKeysEquivalent(scope.state.sessionKey, currentRow.key);
  const cacheKey = owner.sessionSharingCacheKey(currentRow.key);
  const previous = owner.collaboration.sharingStates.get(cacheKey);
  if (!access() || !isCurrent() || previous?.loading) {
    return { status: "unavailable" };
  }
  const pending = { ...previous, loading: true, error: undefined };
  owner.setSessionSharingState(cacheKey, pending);
  try {
    const { setSessionPublicShare } = await import("./chat-pane-sharing-operations.ts");
    return await setSessionPublicShare(scope, currentRow, {
      enabled,
      expectedSessionId,
      agentId: owner.sessionSharingAgentId(currentRow.key),
      previous,
      isCurrent,
      access,
      setState: (state) => owner.setSessionSharingState(cacheKey, state),
      invalidateHydration: () => owner.sessionSharingHydrationTargets.delete(cacheKey),
      reload: (target) => owner.loadSessionSharing(target, true),
      outcome: () => owner.sessionSharingOutcome(cacheKey),
    });
  } catch (error) {
    if (isCurrent()) {
      owner.failSharing(scope, cacheKey, currentRow.key, error);
      return { status: "failed", error: formatUiError(error) };
    }
    return { status: "stale" };
  } finally {
    if (owner.collaboration.sharingStates.get(cacheKey) === pending) {
      owner.setSessionSharingState(cacheKey, { ...previous, loading: false });
    }
  }
}

export async function mutateSessionSharing(
  owner: ChatSessionSharingOperationSource,
  row: GatewaySessionRow,
  change: { visibility: SessionVisibility } | { identityId: string; member: boolean },
): Promise<ChatSessionSharingOutcome> {
  const scope = owner.captureConnectionScope();
  const currentRow = scope ? owner.currentSessionSharingRow(scope, row) : null;
  if (!scope || !currentRow) {
    return { status: "unavailable" };
  }
  if ("visibility" in change && change.visibility === currentRow.visibility) {
    return { status: "unchanged" };
  }
  const agentId = owner.sessionSharingAgentId(currentRow.key);
  const cacheKey = owner.sessionSharingCacheKey(currentRow.key);
  const method =
    "visibility" in change
      ? "session.visibility.set"
      : change.member
        ? "session.members.add"
        : "session.members.remove";
  const params = {
    sessionKey: currentRow.key,
    ...("visibility" in change
      ? { visibility: change.visibility }
      : { identityId: change.identityId }),
    ...(agentId ? { agentId } : {}),
  };
  if (
    !readSessionMethodAccess(scope.context.gateway.snapshot, {
      method,
      requiredScope: "operator.write",
    }).allowed
  ) {
    return { status: "unavailable" };
  }
  const previous = owner.collaboration.sharingStates.get(cacheKey);
  if (previous?.loading) {
    return { status: "unavailable" };
  }
  const pending = { ...previous, loading: true, error: undefined };
  owner.setSessionSharingState(cacheKey, pending);
  try {
    const { mutateSessionSharing } = await import("./chat-pane-sharing-operations.ts");
    return await mutateSessionSharing(scope, currentRow, method, params, {
      agentId,
      visibilityChanged: "visibility" in change,
      isCurrent: () => owner.ownsSessionSharing(scope, currentRow),
      currentRow: () => owner.currentSessionSharingRow(scope, currentRow),
      ownsHeader: () => owner.ownsHeaderOutcomeScope(scope),
      reload: (target) => owner.loadSessionSharing(target, true),
      fail: (error) => owner.failSharing(scope, cacheKey, currentRow.key, error),
      outcome: () => owner.sessionSharingOutcome(cacheKey),
    });
  } catch (error) {
    if (!owner.ownsSessionSharing(scope, currentRow)) {
      return { status: "stale" };
    }
    owner.failSharing(scope, cacheKey, currentRow.key, error);
    return { status: "failed", error: formatUiError(error) };
  } finally {
    if (owner.collaboration.sharingStates.get(cacheKey) === pending) {
      if (previous) {
        owner.setSessionSharingState(cacheKey, previous);
      } else {
        const next = new Map(owner.collaboration.sharingStates);
        next.delete(cacheKey);
        owner.collaboration.sharingStates = next;
      }
    }
  }
}
