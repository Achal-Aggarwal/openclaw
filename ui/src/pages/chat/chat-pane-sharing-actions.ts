import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { SessionsCompanionResetResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult as SessionSharingResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type { ChatPaneConnectionScope } from "./chat-pane-shared.ts";
import { ChatPaneSidePanels } from "./chat-pane-side-panels.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import {
  canManageChatSessionSharing,
  type PreparedPaneSessionSharing,
  type ChatSessionSharingOutcome,
  type ChatSessionSharingProps,
  type ChatSessionSharingState,
} from "./components/chat-session-sharing-shared.tsx";

registerChatSessionEnglish();

const SESSION_MEMBERS_LIST_METHOD = "session.members.listEvidence";

export abstract class ChatPaneSharingActions extends ChatPaneSidePanels {
  private readonly sessionSharingPropsMemo = new ChatPaneHeaderMemo<PreparedPaneSessionSharing>();

  /** Shared presentation facts; loading and mutations remain with this pane's native owner. */
  protected prepareSessionSharing(
    row: GatewaySessionRow | undefined,
    presentation: Pick<
      ChatSessionSharingProps,
      "personActivity" | "ownerViewing" | "showOwner"
    > = {},
  ): PreparedPaneSessionSharing | undefined {
    const snapshot = this.context.gateway.snapshot;
    if (
      !row ||
      ![
        SESSION_MEMBERS_LIST_METHOD,
        "session.visibility.set",
        "session.members.add",
        "session.members.remove",
        "session.publicShare.set",
      ].some((method) => isGatewayMethodAdvertised(snapshot, method) === true)
    ) {
      return undefined;
    }
    const readAccess = readSessionMethodAccess(snapshot, {
      method: SESSION_MEMBERS_LIST_METHOD,
      requiredScope: "operator.read",
    });
    const writeReason = (method: string) => {
      const access = readSessionMethodAccess(snapshot, { method, requiredScope: "operator.write" });
      return access.allowed ? undefined : access.reason;
    };
    const visibilityDisabledReason = writeReason("session.visibility.set");
    const memberAddDisabledReason = writeReason("session.members.add");
    const memberRemoveDisabledReason = writeReason("session.members.remove");
    const publicShareDisabledReason =
      !row.sessionId || isIncognitoSessionKey(row.key)
        ? t("chat.sessionSharing.publicUnavailable")
        : writeReason("session.publicShare.set");
    // Membership and Public need the evidence read; visibility can operate from the session row.
    const openDisabledReason =
      readAccess.allowed || visibilityDisabledReason === undefined ? undefined : readAccess.reason;
    const state = this.collaboration.sharingStates.get(this.sessionSharingCacheKey(row.key));
    const allowedVisibilities = snapshot.hello?.policy?.allowedSessionVisibilities;
    const operationSignal = this.headerSessionMutationAbortController.signal;
    return this.sessionSharingPropsMemo.read(
      [
        row,
        ...Object.entries(row).flat(),
        state,
        allowedVisibilities,
        operationSignal,
        readAccess.allowed,
        openDisabledReason,
        visibilityDisabledReason,
        memberAddDisabledReason,
        memberRemoveDisabledReason,
        publicShareDisabledReason,
        presentation.personActivity,
        presentation.ownerViewing,
        presentation.showOwner,
      ],
      () => ({
        session: row,
        state,
        allowedVisibilities,
        operationSignal,
        membersAvailable: readAccess.allowed,
        openDisabledReason,
        visibilityDisabledReason,
        memberAddDisabledReason,
        memberRemoveDisabledReason,
        publicShareDisabledReason,
        ...presentation,
        onOpen: () => void this.loadSessionSharing(row),
        operations: this,
        onCopyPublicLink: () => this.copySessionPublicLink(row),
      }),
    );
  }

  protected readonly clearSessionCompanion = async (): Promise<boolean> => {
    const scope = this.captureConnectionScope();
    const key = scope?.state.sessionKey;
    if (!scope || !key) {
      return false;
    }
    const agentId = resolveChatAgentId(scope.state);
    try {
      await this.sessionCompanionThreads.reset(
        key,
        (sessionKey) =>
          scope.client.request<SessionsCompanionResetResult>("sessions.companion.reset", {
            sessionKey,
            ...(agentId ? { agentId } : {}),
          }),
        agentId,
      );
      // A tab close may follow only the confirmed reset of its initiating session.
      return (
        this.isConnectionScopeCurrent(scope) &&
        scope.state.sessionKey === key &&
        resolveChatAgentId(scope.state) === agentId
      );
    } catch (error: unknown) {
      if (
        this.presented &&
        this.isConnectionScopeCurrent(scope) &&
        scope.state.sessionKey === key
      ) {
        this.publishHeaderError(error);
      }
      return false;
    }
  };

  setSessionSharingState(cacheKey: string, state: ChatSessionSharingState): void {
    this.collaboration.sharingStates = new Map(this.collaboration.sharingStates).set(
      cacheKey,
      state,
    );
  }

  sessionSharingAgentId(sessionKey: string): string | undefined {
    if (sessionKey !== "global") {
      return parseAgentSessionKey(sessionKey)?.agentId;
    }
    return this.state ? resolveChatAgentId(this.state) : undefined;
  }

  sessionSharingCacheKey(sessionKey: string): string {
    return `${this.sessionSharingAgentId(sessionKey) ?? ""}\0${sessionKey}`;
  }

  currentSessionSharingRow(
    scope: ChatPaneConnectionScope,
    row: GatewaySessionRow,
  ): GatewaySessionRow | null {
    const current = scope.state.sessionsResult?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, row.key),
    );
    if (!current || !canManageChatSessionSharing(row) || !canManageChatSessionSharing(current)) {
      return null;
    }
    if (current === row) {
      return current;
    }
    const rowSessionId = row.sessionId?.trim();
    const currentSessionId = current.sessionId?.trim();
    return rowSessionId && currentSessionId && rowSessionId === currentSessionId ? current : null;
  }

  ownsSessionSharing(scope: ChatPaneConnectionScope, row: GatewaySessionRow): boolean {
    return this.ownsHeaderOutcomeScope(scope) && this.currentSessionSharingRow(scope, row) !== null;
  }

  async loadSessionSharing(row: GatewaySessionRow, force = false): Promise<void> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (
      !scope ||
      !currentRow ||
      !readSessionMethodAccess(scope.context.gateway.snapshot, {
        method: SESSION_MEMBERS_LIST_METHOD,
        requiredScope: "operator.read",
      }).allowed
    ) {
      return;
    }
    const cacheKey = this.sessionSharingCacheKey(currentRow.key);
    const current = this.collaboration.sharingStates.get(cacheKey);
    if (current?.loading && !force) {
      return;
    }
    // Sharing data (membership + paired identities) is connection-scoped. A
    // gateway/account change bumps the generation and clears this cache, so a
    // request that resolves after the switch must be dropped rather than
    // overwrite the new connection's menu with the previous account's data.
    // Object identity also owns this key's request slot: same-key session
    // replacement or a forced reload must not let an older request win.
    const completion = Promise.withResolvers<void>();
    const loadingState = { ...current, loading: true, error: undefined, read: completion.promise };
    const ownsLoadingState = () => this.collaboration.sharingStates.get(cacheKey) === loadingState;
    this.setSessionSharingState(cacheKey, loadingState);
    try {
      let next: ChatSessionSharingState;
      try {
        const result = await scope.client.request<SessionSharingResult>(
          SESSION_MEMBERS_LIST_METHOD,
          {
            sessionKey: currentRow.key,
            ...(this.sessionSharingAgentId(currentRow.key)
              ? { agentId: this.sessionSharingAgentId(currentRow.key) }
              : {}),
          },
        );
        next = {
          loading: false,
          result,
          ...(result.publicShare ? { publicUrl: this.sessionPublicUrl(scope, currentRow) } : {}),
        };
      } catch (error) {
        next = { ...current, loading: false, error: formatUiError(error) };
      }
      if (!this.ownsSessionSharing(scope, currentRow) || !ownsLoadingState()) {
        if (this.isConnectionScopeCurrent(scope) && ownsLoadingState()) {
          const sharingStates = new Map(this.collaboration.sharingStates);
          sharingStates.delete(cacheKey);
          this.collaboration.sharingStates = sharingStates;
        }
        return;
      }
      delete next.read;
      this.setSessionSharingState(cacheKey, next);
    } finally {
      completion.resolve();
    }
  }

  failSharing(scope: ChatPaneConnectionScope, key: string, session: string, error: unknown): void {
    if (!this.ownsHeaderOutcomeScope(scope)) {
      return;
    }
    this.setSessionSharingState(key, {
      ...(this.collaboration.sharingStates.get(key) ?? { loading: false }),
      loading: false,
      error: formatUiError(error),
    });
    // Sharing errors stay with their session; the visible slot belongs only to the selected session.
    if (areUiSessionKeysEquivalent(this.state?.sessionKey, session)) {
      this.publishHeaderError(error, scope.headerOutcomeOwner);
    }
  }

  private sessionPublicUrl(
    scope: ChatPaneConnectionScope,
    currentRow: GatewaySessionRow,
  ): string | undefined {
    const gateway = scope.context.gateway;
    const controlUiUrl = gateway.snapshot.hello?.controlUiUrl;
    const linkBase = controlUiUrl ?? scope.client.gatewayUrl ?? gateway.connection.gatewayUrl;
    const url = new URL(linkBase || window.location.href);
    url.protocol = url.protocol.replace(/^ws/u, "http");
    const path = buildControlUiSessionPath({
      namespace: "chat",
      sessionKey: currentRow.key,
      fallbackAgentId: this.sessionSharingAgentId(currentRow.key),
      basePath: controlUiUrl ? url.pathname : scope.context.basePath,
      displayName: currentRow.label || currentRow.displayName,
      shortIdLength: 32,
    });
    if (!path) {
      return undefined;
    }
    return new URL(path, url.origin).href;
  }

  sessionSharingOutcome(cacheKey: string): ChatSessionSharingOutcome {
    const error = this.collaboration.sharingStates.get(cacheKey)?.error;
    return error ? { status: "failed", error } : { status: "success" };
  }

  protected async copySessionPublicLink(
    row: GatewaySessionRow,
  ): Promise<ChatSessionSharingOutcome> {
    const scope = this.captureConnectionScope();
    const currentRow = scope ? this.currentSessionSharingRow(scope, row) : null;
    if (!scope || !currentRow) {
      return { status: "unavailable" };
    }
    const share = this.collaboration.sharingStates.get(this.sessionSharingCacheKey(row.key))?.result
      ?.publicShare;
    const expectedSessionId = currentRow.sessionId;
    if (!share || !expectedSessionId) {
      return { status: "unavailable" };
    }
    const isCurrent = () =>
      this.ownsHeaderOutcomeScope(scope) &&
      this.currentSessionSharingRow(scope, currentRow)?.sessionId === expectedSessionId;
    try {
      const url =
        this.collaboration.sharingStates.get(this.sessionSharingCacheKey(currentRow.key))
          ?.publicUrl ?? this.sessionPublicUrl(scope, currentRow);
      if (!url) {
        return { status: "unavailable" };
      }
      const copied = await copyToClipboard(url, isCurrent);
      if (isCurrent()) {
        showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
        return copied ? { status: "success" } : { status: "failed", error: t("common.copyFailed") };
      }
      return { status: "stale" };
    } catch (error) {
      if (isCurrent()) {
        this.publishHeaderError(error);
        return { status: "failed", error: formatUiError(error) };
      }
      return { status: "stale" };
    }
  }

  captureConnectionScope(): ChatPaneConnectionScope | null {
    const state = this.state;
    if (!state?.client) {
      return null;
    }
    const scope = {
      context: this.context,
      state,
      client: state.client,
      generation: this.connectionGeneration,
      headerOutcomeOwner: this.headerOutcomeOwner,
      sessions: this.context.sessions,
    };
    return this.isConnectionScopeCurrent(scope) ? scope : null;
  }

  protected isConnectionScopeCurrent(
    scope: Pick<ChatPaneConnectionScope, "context" | "state" | "client" | "generation">,
  ): boolean {
    return (
      this.isConnected &&
      this.context === scope.context &&
      this.state === scope.state &&
      scope.state.connected &&
      scope.state.client === scope.client &&
      this.connectedClient === scope.client &&
      scope.context.gateway.snapshot.phase === "connected" &&
      scope.context.gateway.snapshot.client === scope.client &&
      this.connectionGeneration === scope.generation
    );
  }

  ownsHeaderOutcomeScope(scope: ChatPaneConnectionScope): boolean {
    return this.isConnectionScopeCurrent(scope) && this.ownsHeaderOutcome(scope.headerOutcomeOwner);
  }
}
