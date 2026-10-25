import type { Element } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import type { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { ChatPaneBoard } from "./chat-pane-board.ts";
import type { createChatPaneDiscussionState } from "./chat-pane-discussion-state.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
import type { SidebarLayout } from "./sidebar-layout.ts";

/** References to the existing owner, never a second copy of pane or connection state. */
export type ChatBoardPanelSource = {
  controls?: Element;
  owner: Pick<
    ChatPaneBoard,
    | "element"
    | "presented"
    | "visuallyPresented"
    | "connectionGeneration"
    | "paneId"
    | "sessionKey"
    | "onFaceChange"
    | "boardView"
    | "selectBoardTab"
  >;
  board: ResolvedBoardView;
  layout: SidebarLayout;
  session: ReturnType<typeof resolveUiConversationIdentity>;
  connectionGeneration: number;
  pageWidgetName: string | undefined;
};

export type ChatDiscussionPanelSource = {
  owner: {
    readonly context: ApplicationContext;
    readonly connectionGeneration: number;
    readonly sessionDiscussion: ReturnType<typeof createChatPaneDiscussionState>;
    readonly sessionDiscussionPanels: Map<
      string,
      {
        generation: number;
        canOpen: boolean;
        config: SessionDiscussionPanelConfig;
      }
    >;
  };
  state: ChatPageHost;
  sessionKey: string;
  generation: number;
  canOpen: boolean;
  openUrl: string | null;
};
