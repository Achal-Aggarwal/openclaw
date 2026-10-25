import type { GatewaySessionRow } from "../../api/types.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import type { SidebarSessionMutationResult } from "../../components/app-sidebar-session-types.ts";
import { t } from "../../i18n/index.ts";
import { openEditor } from "../../lib/editor-links.ts";
import {
  areUiSessionKeysEquivalent,
  isPinnableUiSessionRow,
  isNativeCatalogAdoptionSessionKey,
} from "../../lib/sessions/session-key.ts";
import { runSessionNavigationAction } from "../../lib/sessions/session-menu-navigation.ts";
import { runControlUiPluginAction } from "../../plugins/control-ui-actions.ts";
import type { ChatPaneSessionMenu } from "./chat-pane-session-menu.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";

export type ChatHeaderSessionActionSource = {
  /** Keep mutation authority outside the menu's deep presentation projection. */
  readOwner: () => Pick<
    ChatPaneSessionMenu,
    | "context"
    | "state"
    | "mergedChrome"
    | "headerOutcomeOwner"
    | "changeHeaderPlacement"
    | "canArchiveHeaderSession"
    | "beginHeaderRename"
    | "ownsHeaderOutcome"
    | "openContinueInTerminalDialog"
    | "openHeaderSessionGroup"
    | "publishHeaderError"
    | "runHeaderSessionMutation"
    | "captureHeaderSessionActionScope"
  >;
  readRow: () => GatewaySessionRow | undefined;
  stopDisabledReason: string | undefined;
};

/** Loaded by the menu before its actions exist; gesture-bound work stays synchronous. */
export async function runChatHeaderSessionAction(
  owner: ReturnType<ChatHeaderSessionActionSource["readOwner"]>,
  action: HeaderMenuAction,
  row: GatewaySessionRow,
): Promise<SidebarSessionMutationResult | void> {
  if (action.kind === "delete" && isNativeCatalogAdoptionSessionKey(row.key)) {
    return;
  }
  if (action.kind === "move-session" || action.kind === "stop-cloud-worker") {
    return owner.changeHeaderPlacement(row, action.kind === "move-session" ? "move" : "reclaim");
  }
  if (action.kind === "toggle-archived" && !row.archived && !owner.canArchiveHeaderSession(row)) {
    return;
  }
  if (action.kind === "open-in") {
    openEditor(action.editor, action.path);
    return;
  }
  if (action.kind === "rename" && !owner.mergedChrome) {
    return owner.beginHeaderRename(row);
  }
  if (
    action.kind === "copy-session-id" ||
    action.kind === "copy-session-link" ||
    action.kind === "copy-session-preview-link" ||
    action.kind === "copy-markdown" ||
    action.kind === "open-new-tab" ||
    action.kind === "open-new-window" ||
    action.kind === "split-right" ||
    action.kind === "split-below"
  ) {
    const ownerKey = owner.headerOutcomeOwner;
    await runSessionNavigationAction(action.kind, {
      context: owner.context,
      session: row,
      agentId: owner.state ? resolveChatAgentId(owner.state) : row.agentId,
      sourceSessionKey: row.key,
      isCurrent: () => owner.ownsHeaderOutcome(ownerKey),
    });
    return;
  }
  if (action.kind === "continue-in-terminal") {
    owner.openContinueInTerminalDialog(row);
    return;
  }
  if (action.kind === "toggle-pin") {
    const current = owner.state ? selectedChatSessionRow(owner.state) : undefined;
    if (
      !current ||
      !areUiSessionKeysEquivalent(current.key, row.key) ||
      (row.sessionId && current.sessionId !== row.sessionId) ||
      !isPinnableUiSessionRow(current)
    ) {
      return;
    }
    togglePinnedSession(owner.context.navigation, current.key);
    return;
  }
  if (action.kind === "new-group") {
    return owner.openHeaderSessionGroup(row);
  }
  if (action.kind === "plugin") {
    const scope = owner.captureHeaderSessionActionScope();
    if (!scope) {
      owner.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const ownerKey = owner.headerOutcomeOwner;
    const current = owner.state ? selectedChatSessionRow(owner.state) : undefined;
    try {
      await runControlUiPluginAction({
        runtime: owner.context.plugins,
        id: action.id,
        placement: "session",
        sessionKey: row.key,
        agentId: row.agentId,
        session:
          current?.key === row.key && current.sessionId === row.sessionId ? current : undefined,
        signal: scope.signal,
      });
    } catch (error) {
      owner.publishHeaderError(error, ownerKey);
    }
    return;
  }
  return owner.runHeaderSessionMutation(action, row);
}
