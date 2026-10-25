import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SidebarSessionMutationResult } from "../../components/app-sidebar-session-types.ts";
import type { SessionManagementAction } from "../../components/session-menu-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export type HeaderMenuAction =
  | SessionManagementAction
  | { kind: "continue-in-terminal" }
  | { kind: "stop-cloud-worker" }
  | { kind: "plugin"; id: string };
export type HeaderMenuActionKind = HeaderMenuAction["kind"];

export type HeaderSessionOperation = Exclude<
  HeaderMenuAction,
  {
    kind:
      | "move-session"
      | "stop-cloud-worker"
      | "open-in"
      | "copy-session-id"
      | "copy-session-link"
      | "copy-session-preview-link"
      | "copy-markdown"
      | "open-new-tab"
      | "open-new-window"
      | "split-right"
      | "split-below"
      | "continue-in-terminal"
      | "toggle-pin"
      | "new-group"
      | "plugin";
  }
>;

type ChatHeaderSessionActionOwner = {
  context: ApplicationContext;
  state: ChatPageHost | undefined;
  mergedChrome: boolean;
  headerOutcomeOwner: string;
  changeHeaderPlacement(row: GatewaySessionRow, mode: "move" | "reclaim"): Promise<void>;
  canArchiveHeaderSession(row: GatewaySessionRow): boolean;
  beginHeaderRename(row: GatewaySessionRow): void;
  ownsHeaderOutcome(owner: string): boolean;
  openContinueInTerminalDialog(row: GatewaySessionRow): void;
  openHeaderSessionGroup(row: GatewaySessionRow): Promise<void>;
  publishHeaderError(error: unknown, owner?: string): void;
  runHeaderSessionMutation(
    action: HeaderSessionOperation,
    row: GatewaySessionRow,
  ): Promise<SidebarSessionMutationResult | void>;
  captureHeaderSessionActionScope(): { signal: AbortSignal } | null;
};

export type ChatHeaderSessionActionSource = {
  /** Keep mutation authority outside the menu's deep presentation projection. */
  readOwner: () => ChatHeaderSessionActionOwner;
  readRow: () => GatewaySessionRow | undefined;
  stopDisabledReason: string | undefined;
};
