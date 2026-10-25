import { dynamic } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  lazy,
  merge,
  Show,
  type Component,
  type Element,
} from "solid-js";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { chatPaneLayoutModel, ChatPaneLayoutHeaderActions } from "./chat-header-panel-actions.tsx";
import type { HeaderSessionMenuMobileHost } from "./chat-header-session-menu-mobile.tsx";
import { ChatHeaderSessionMenu } from "./chat-header-session-menu.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";
import type { ChatPanePlacementProps } from "./chat-pane-placement.tsx";
import type { HeaderMenuSessionAction } from "./chat-quick-action.tsx";

const ChatPaneMobileRuntime = lazy(() => import("./chat-pane-mobile-runtime.tsx"), {
  export: "ChatPaneMobileRuntime",
});

/** Native navigation and menu methods become available with the retained mobile renderer. */
export type ChatPaneMobileActions = {
  sessionActions: (nativeActions: HeaderMenuSessionAction[]) => HeaderMenuSessionAction[];
  compactActions: () => HeaderMenuSessionAction[];
  menuHost: HeaderSessionMenuMobileHost;
  pageOpen: () => boolean;
  openMachine: () => void;
  openMove: () => void;
};

/** The shared Details and native session-menu owners survive viewport changes. */
export function ChatPaneMobileComposition(props: {
  header: ChatPaneHeaderProps;
  project?: Element;
  details: Component<{ placement: ChatPanePlacementProps; onOpenMachine: () => void }>;
  notice: Element;
  fallback: (
    sessionMenu: Element,
    machineName: () => string | undefined,
    details: Element,
  ) => Element;
}) {
  const mobile = () =>
    Boolean(props.header.mergedChrome && props.header.detailsControl?.mobileHost);
  const mobileActivated = createMemo<boolean>((previous) => previous === true || mobile());
  const [mobileActions, setMobileActions] = createSignal<ChatPaneMobileActions>();
  const emptyPlacement: ChatPanePlacementProps = { session: undefined };
  const readMachineName = createMemo(() => props.header.readMachineName);
  const machineNameRead = createMemo(() => {
    const read = readMachineName();
    // A new request identity starts empty while Solid retires the previous result.
    if (!read) {
      return undefined;
    }
    const name = createMemo(read, { loadingValue: undefined });
    return name;
  });
  const machineName = () => machineNameRead()?.();
  const placement = merge(
    () => props.header.placementControl ?? emptyPlacement,
    () => ({
      machineName: machineName(),
      onPlacementReclaim: props.header.onMobilePlacementStop
        ? () => {
            void props.header.onMobilePlacementStop?.(machineName());
          }
        : props.header.placementControl?.onPlacementReclaim,
    }),
  );
  const Details = dynamic(() => props.details);
  // The component identity and its DOM stay retained across mobile and desktop placement.
  const details = (
    <Details placement={placement} onOpenMachine={() => mobileActions()?.openMachine()} />
  );
  let actionsMenu: HTMLElementTagNameMap["openclaw-chat-header-session-menu"] | undefined;
  const registerActionsMenu = (element: NonNullable<typeof actionsMenu>) => {
    actionsMenu = element;
    return () => {
      if (actionsMenu === element) {
        actionsMenu = undefined;
      }
    };
  };
  const actionSource = () => actionsMenu?.readTrigger();
  const layoutProps = merge(
    () => props.header,
    () => ({ mobile: props.header.mergedChrome }),
  );
  const layoutModel = createMemo(() => chatPaneLayoutModel(layoutProps));
  const layoutActions = () => layoutModel().allActions;
  // Desktop View keeps only session-pane closure; panel controls belong to their frames.
  const desktopViewActions = () =>
    layoutModel().actions.filter((action) => action.id === "close-pane");
  const desktopSessionActions = (
    nativeActions = props.header.sessionMenuAction?.sessionActions ?? [],
  ): HeaderMenuSessionAction[] => [
    ...nativeActions,
    ...(!props.header.mergedChrome
      ? layoutModel().actions.flatMap((action) =>
          action.id === "open-split-view" && action.kind !== "status" ? [action] : [],
        )
      : []),
  ];
  // One native menu also serves desktop/native-command callers. Its page roots
  // outlive the placement of the trigger in either header.
  const sessionCommandsAvailable = () =>
    mobile()
      ? !props.header.gatewayStatus?.kind || props.header.gatewayStatus.kind === "connected"
      : props.header.gatewayStatus?.kind !== "offline" &&
        props.header.gatewayStatus?.kind !== "reconnecting";
  // Keep the trigger mounted as metadata arrives or the connection changes so keyboard focus survives.
  const sessionMenuAction = () =>
    sessionCommandsAvailable() ? props.header.sessionMenuAction : undefined;
  const sessionMenu = (
    <Show
      when={
        mobile() ||
        (sessionCommandsAvailable() &&
          (props.header.sessionMenuAction ||
            (!props.header.actionsDisabled &&
              (desktopSessionActions().length > 0 || desktopViewActions().length > 0))))
      }
    >
      <span>
        <ChatHeaderSessionMenu
          ref={elementRef(registerActionsMenu)}
          {...sessionMenuAction()}
          paneTitle={sessionMenuAction() ? undefined : props.header.title}
          composeSessionActions={(nativeActions) =>
            mobile()
              ? sessionCommandsAvailable()
                ? (mobileActions()?.sessionActions(nativeActions) ?? nativeActions)
                : (mobileActions()?.compactActions() ?? [])
              : desktopSessionActions(nativeActions)
          }
          viewActions={mobile() ? layoutActions() : desktopViewActions()}
          viewContent={
            mobile() ? (
              <ChatPaneLayoutHeaderActions
                model={layoutModel()}
                omitMain={props.header.panelActionDestinations?.main}
                omitSide={props.header.panelActionDestinations?.side}
              />
            ) : undefined
          }
          onAction={(action) => {
            // Session keys can repeat across panes; retain the originating pane identity.
            if (mobile() && action.kind === "move-session") {
              mobileActions()?.openMove();
            } else if (!mobile() && action.kind === "split-right" && props.header.onSplitRight) {
              props.header.onSplitRight(props.header.paneId);
            } else if (!mobile() && action.kind === "split-below" && props.header.onSplitDown) {
              props.header.onSplitDown(props.header.paneId);
            } else {
              const handler = sessionMenuAction()?.onAction;
              return handler ? handler(action) : false;
            }
          }}
          mobile={mobile() || sessionMenuAction()?.mobile}
          mobileHost={mobile() ? mobileActions()?.menuHost : undefined}
          mobilePageOpen={mobileActions()?.pageOpen() ?? false}
        />
      </span>
    </Show>
  );
  return (
    <>
      <Show when={mobileActivated()}>
        <ChatLazyBoundary>
          <ChatPaneMobileRuntime
            header={props.header}
            project={props.project}
            details={details}
            notice={props.notice}
            sessionMenu={sessionMenu}
            placement={placement}
            machineName={machineName}
            layoutModel={layoutModel}
            actionSource={actionSource}
            onReady={setMobileActions}
          />
        </ChatLazyBoundary>
      </Show>
      <Show when={!mobile()}>{props.fallback(sessionMenu, machineName, details)}</Show>
    </>
  );
}
