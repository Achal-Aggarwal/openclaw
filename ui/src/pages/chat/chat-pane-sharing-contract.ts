import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import type { ChatPaneConnectionScope } from "./chat-pane-shared.ts";

export type ChatSessionSharingOutcome =
  | { status: "success" }
  | { status: "unchanged" | "unavailable" | "cancelled" | "stale" }
  | { status: "failed"; error: string };

export type ChatSessionSharingState = {
  loading: boolean;
  /** Completes after the pane publishes or retires its admitted membership read. */
  read?: Promise<void>;
  result?: SessionMembersListEvidenceResult;
  publicUrl?: string;
  error?: string;
};

/** The lazy surface supplies code; pending state and authority remain on the pane. */
export type ChatSessionSharingOperationSource = {
  captureConnectionScope(): ChatPaneConnectionScope | null;
  currentSessionSharingRow(
    scope: ChatPaneConnectionScope,
    row: GatewaySessionRow,
  ): GatewaySessionRow | null;
  ownsHeaderOutcomeScope(scope: ChatPaneConnectionScope): boolean;
  sessionSharingCacheKey(sessionKey: string): string;
  sessionSharingAgentId(sessionKey: string): string | undefined;
  collaboration: { sharingStates: Map<string, ChatSessionSharingState> };
  setSessionSharingState(cacheKey: string, state: ChatSessionSharingState): void;
  sessionSharingHydrationTargets: Pick<Map<string, string>, "delete">;
  loadSessionSharing(row: GatewaySessionRow, force?: boolean): Promise<void>;
  sessionSharingOutcome(cacheKey: string): ChatSessionSharingOutcome;
  failSharing(scope: ChatPaneConnectionScope, key: string, session: string, error: unknown): void;
  ownsSessionSharing(scope: ChatPaneConnectionScope, row: GatewaySessionRow): boolean;
};
