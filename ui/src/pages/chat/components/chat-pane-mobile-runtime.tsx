import {
  Errored,
  Loading,
  lazy,
  createMemo,
  createSignal,
  onSettled,
  Show,
  type Accessor,
  type Element,
} from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import type { SessionPlacementPresentation } from "../../../components/session-placement-move-dialog.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { MobileHostDestination } from "../chat-mobile-host.ts";
import { companionClearAction } from "../chat-panel-header-actions.tsx";
import type { chatPaneLayoutModel } from "./chat-header-panel-actions.tsx";
import type { HeaderSessionMenuPage } from "./chat-header-session-menu-mobile.tsx";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";
import type { ChatPaneMobileActions } from "./chat-pane-mobile-composition.tsx";
import {
  createChatMachinePresentation,
  type ChatPanePlacementProps,
} from "./chat-pane-placement.tsx";
import type { HeaderMenuSessionAction } from "./chat-quick-action.tsx";
import { createChatSessionSharingMobileAdapter } from "./chat-session-sharing-mobile-adapter.tsx";
import { ChatSessionSharingOptions } from "./chat-session-sharing-options.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

/** Mobile destinations stay alive when the shared header returns to desktop. */
export function ChatPaneMobileRuntime(props: {
  header: ChatPaneHeaderProps;
  presented: boolean;
  incognito: boolean;
  compactActions: boolean;
  placement: ChatPanePlacementProps;
  layoutModel: Accessor<ReturnType<typeof chatPaneLayoutModel>>;
  actionSource: () => HTMLElement | undefined;
  onReady: (actions: ChatPaneMobileActions | undefined) => void;
}) {
  let disposed = false;
  // The destination's first visit mounts its content under this retained header owner.
  const retainPage = (render: () => Element) => {
    const opened = createMemo<boolean>(
      (previous) => previous === true || host()?.destination.page?.render === page,
    );
    const content = (
      <Show when={opened()}>
        <Errored
          fallback={(error, reset) => (
            <LazyViewError
              error={error()}
              stale={isStaleChunkImportError(error())}
              onRetry={() => {
                if (!isStaleChunkImportError(error())) {
                  reset();
                  return;
                }
                const scopeKey = host()?.scopeKey;
                const destination = host()?.destination;
                void retryStaleChunkReloadWhenReachable({
                  canReload: () => {
                    const current = host();
                    return (
                      !disposed &&
                      current?.open === true &&
                      !current.suspended &&
                      current.scopeKey === scopeKey &&
                      current.destination === destination
                    );
                  },
                });
              }}
              inline
            />
          )}
        >
          <Loading
            fallback={
              <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
            }
          >
            {render()}
          </Loading>
        </Errored>
      </Show>
    );
    function page() {
      return disposed ? undefined : content;
    }
    return page;
  };
  const ChatMobilePeopleBody = lazy(() => import("./chat-mobile-people.tsx"), {
    export: "ChatMobilePeopleBody",
  });
  const ChatMachine = lazy(() => import("./chat-machine.tsx"), { export: "ChatMachine" });
  const ChatSessionSharingMobile = lazy(() => import("./chat-session-sharing-mobile.tsx"), {
    export: "ChatSessionSharingMobile",
  });
  const ChatSessionAccessMobile = lazy(() => import("./chat-session-sharing-mobile.tsx"), {
    export: "ChatSessionAccessMobile",
  });
  const host = () => props.header.detailsControl?.mobileHost;
  const sharing = () => props.header.mobileSharing;
  const machine = createChatMachinePresentation(props.placement);
  const peopleId = () => `${props.header.paneId}-mobile-people`;
  const labels = {
    get people() {
      return t("chat.sessionHeader.people");
    },
    get viewingNow() {
      return t("activityFeed.viewingNow");
    },
    get creator() {
      return t("chat.sessionSharing.creator");
    },
    get owner() {
      return t("chat.sessionSharing.owner");
    },
    get participants() {
      return t("chat.sessionHeader.peopleParticipants");
    },
    get mention() {
      return t("chat.sessionHeader.mention");
    },
    mentionPerson: (name: string) => t("chat.sessionHeader.mentionPerson", { name }),
    morePeople: (count: number) => t("chat.sessionHeader.morePeople", { count: String(count) }),
  };
  const adapter = createChatSessionSharingMobileAdapter(sharing, {
    onOpenSharing: () => {
      const current = host();
      // Sharing opened within People retains the People trigger as its return focus.
      current?.navigate(
        sharingPage,
        current.open && current.destination === people ? undefined : props.actionSource(),
      );
    },
    onOpenAccess: () => host()?.navigate(accessPage),
    onApplied: () => host()?.navigate(sharingPage),
    accessTarget: () =>
      props.presented && host()?.open && !host()?.suspended && host()?.destination === accessPage
        ? accessPage
        : undefined,
  });
  const people: MobileHostDestination = {
    area: "details",
    backTo: { area: "details" },
    page: {
      key: "people",
      get title() {
        return labels.people;
      },
      render: retainPage(() => (
        <div id={peopleId()}>
          <Show when={props.header.mobilePeopleMentions?.status === "loading"}>
            <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
          </Show>
          <Show
            when={
              props.header.mobilePeopleMentions?.status === "error" ||
              props.header.mobilePeopleMentions?.status === "unavailable" ||
              props.header.mobilePeopleMentions?.status === "insert-rejected"
            }
          >
            <p role="alert">
              {props.header.mobilePeopleMentions?.status === "insert-rejected"
                ? t("chat.sessionHeader.mentionRejected")
                : (props.header.mobilePeopleMentions?.error ?? t("chat.mentions.unavailable"))}
              <button
                type="button"
                class="btn btn--ghost"
                onClick={() => void props.header.mobilePeopleMentions?.request()}
              >
                {t("common.retry")}
              </button>
            </p>
          </Show>
          <Show when={props.header.mobilePeopleMentions?.truncated}>
            <p role="status">{t("chat.sessionHeader.mentionsTruncated")}</p>
          </Show>
          <Show when={props.header.mobilePeople}>
            {(data) => (
              <ChatMobilePeopleBody
                people={data()}
                labels={labels}
                onMention={(person) => {
                  if (props.header.mobilePeopleMentions?.insert(person.profileId)) {
                    // Native close restores its source synchronously; the queued
                    // composer focus runs afterwards. Do not add another focus task.
                    host()?.close();
                  }
                }}
                sharingOptions={
                  <Show when={adapter.available}>
                    <ChatSessionSharingOptions {...adapter.options} />
                  </Show>
                }
              />
            )}
          </Show>
        </div>
      )),
    },
  };
  // A viewport round-trip parks this page. Only entering/leaving the native
  // destination starts/releases the explicit People lookup, not rendering it.
  const peopleActive = createMemo<boolean>((previous) => {
    const current = host();
    return current ? current.open && current.destination === people : (previous ?? false);
  });
  const sharingPage: MobileHostDestination = {
    area: "details",
    backTo: people,
    page: {
      key: "sharing",
      get title() {
        return t("chat.sessionSharing.sharingOptions");
      },
      render: retainPage(() => <ChatSessionSharingMobile {...adapter.sharing} />),
    },
  };
  const accessPage: MobileHostDestination = {
    area: "details",
    backTo: sharingPage,
    page: {
      key: "sharing-access",
      get title() {
        return t("chat.sessionSharing.sessionAccess");
      },
      render: retainPage(() => <ChatSessionAccessMobile {...adapter.access} />),
    },
  };
  const machinePage: MobileHostDestination = {
    area: "details",
    backTo: { area: "details" },
    page: {
      key: "machine",
      get title() {
        return t("sessionsView.placementFactMachine");
      },
      render: retainPage(() => (
        <ChatMachine
          {...props.placement}
          onPlacementMove={
            props.header.onMobilePlacementMove ? openMove : props.placement.onPlacementMove
          }
        />
      )),
    },
  };
  const [moveRequest, setMoveRequest] = createSignal<Parameters<SessionPlacementPresentation>[0]>();
  let moveSessionKey: string | undefined;
  const movePage: MobileHostDestination = {
    area: "details",
    backTo: machinePage,
    page: {
      key: "machine-move",
      get title() {
        return moveRequest()?.title ?? t("sessionsView.moveSessionTitle");
      },
      content: (
        <Show when={moveRequest()} keyed>
          {(request) => request.render()}
        </Show>
      ),
    },
  };
  function openMove() {
    const sessionKey = props.header.session?.key;
    const onPresent: SessionPlacementPresentation = (request) => {
      if (!host() || props.header.session?.key !== sessionKey) {
        request.cancel();
        return () => {};
      }
      moveSessionKey = sessionKey;
      setMoveRequest(request);
      host()?.navigate(movePage);
      return () => {
        setMoveRequest(undefined);
        const current = host();
        if (current?.open && current.destination === movePage) {
          current.navigate(machinePage);
        }
      };
    };
    void props.header.onMobilePlacementMove?.(onPresent);
  }
  const movePresentation = createMemo<{
    request: ReturnType<typeof moveRequest>;
    visited: boolean;
  }>((previous) => {
    const request = moveRequest();
    const current = host();
    return {
      request,
      // Desktop parking retains navigation; only an observed native entry can exit it.
      visited: Boolean(
        request &&
        ((current?.destination === movePage && current.open) ||
          (previous?.request === request && previous.visited)),
      ),
    };
  });
  const cancelledMove = () => {
    const { request, visited } = movePresentation();
    const current = host();
    return request &&
      (props.header.session?.key !== moveSessionKey ||
        (visited && current && (current.destination !== movePage || !current.open)))
      ? request
      : undefined;
  };
  const clearSideChat = createMemo(() => {
    const model = props.layoutModel();
    const source = model.sideHeaderActionView ?? model.mainHeaderActionView;
    return source ? companionClearAction(source) : undefined;
  });
  const compactHeaderActions = createMemo((): HeaderMenuSessionAction[] =>
    props.compactActions
      ? [
          ...(props.header.onOpenDashboard
            ? [
                {
                  id: "header-dashboard",
                  label: t("pluginUi.dashboardTitle"),
                  icon: "layoutDashboard" as const,
                  onActivate: () => {
                    const source = props.actionSource();
                    if (source) {
                      props.header.onOpenDashboard?.(source);
                    }
                  },
                },
              ]
            : []),
          {
            id: "header-panels",
            label: t("chat.sessionHeader.panels"),
            icon: "sessionPanels" as const,
            onActivate: () => {
              host()?.reveal(props.actionSource());
            },
          },
        ]
      : [],
  );
  const nativeActions = (sessionActions: HeaderMenuSessionAction[]): HeaderMenuSessionAction[] => [
    ...compactHeaderActions(),
    ...(clearSideChat() ? [clearSideChat()!] : []),
    ...(props.header.runAction
      ? [
          {
            id: "stop-running-subagent",
            label: t("chat.runControls.stopGenerating"),
            icon: "stop" as const,
            onActivate: () => props.header.runAction?.onAbort(),
          },
        ]
      : []),
    ...sessionActions,
    ...(machine()?.showPlacementMenu
      ? [
          {
            id: "header-machine",
            label: t("sessionsView.placementFactMachine"),
            icon: "monitor" as const,
            onActivate: () => host()?.navigate(machinePage, props.actionSource()),
          },
        ]
      : []),
    ...(props.header.agent
      ? [
          {
            id: "header-agent-settings",
            label: t("agentChip.namedSettings", { name: props.header.agent.name }),
            icon: "settings" as const,
            onActivate: () => {
              if (props.header.agent) {
                props.header.onOpenAgentSettings?.(props.header.agent.id);
              }
            },
          },
        ]
      : []),
    ...(adapter.available && (!props.header.mobilePeople?.header.length || props.incognito)
      ? [
          {
            id: "header-sharing",
            label: t("chat.sessionSharing.sharingOptions"),
            icon: "users" as const,
            onActivate: () => {
              adapter.options.onOpen();
            },
          },
        ]
      : []),
  ];
  const adaptMenuPage = (page: HeaderSessionMenuPage): MobileHostDestination => ({
    area: "details",
    transient: true,
    page,
    backTo: page.backTo
      ? adaptMenuPage(page.backTo)
      : page.key === "session-advanced"
        ? { area: "details" }
        : undefined,
  });
  const menuHost = {
    open: (page: HeaderSessionMenuPage, source: HTMLElement) =>
      host()?.navigate(adaptMenuPage(page), source),
    close: () => host()?.close(),
    isCurrent: (page: HeaderSessionMenuPage) => {
      const current = host();
      return Boolean(
        props.presented && current?.open && !current.suspended && current.destination.page === page,
      );
    },
  };
  const actionsPageOpen = createMemo(() =>
    Boolean(
      props.presented && host()?.open && host()?.destination.page?.key.startsWith("session-"),
    ),
  );
  onSettled(() => {
    props.onReady({
      sessionActions: nativeActions,
      compactActions: compactHeaderActions,
      menuHost,
      pageOpen: actionsPageOpen,
      deviceOffline: () => machine()?.deviceOffline,
      peopleExpanded: () =>
        Boolean(host()?.open && !host()?.suspended && host()?.destination === people),
      openMachine: (source) => host()?.navigate(machinePage, source),
      openPeople: (source) => {
        const current = host();
        if (!current) {
          return;
        }
        // Set native expansion before revealing the destination, in the same synchronous intent.
        // A closed host has no visible dock to reserve behind the expanded page.
        if (current.mode !== "expanded") {
          const shell = current.detailsMount?.closest<HTMLElement>(".chat-mobile-host");
          current.toggleExpanded(
            current.open && !current.suspended ? (shell?.getBoundingClientRect().height ?? 0) : 0,
          );
        }
        current.navigate(people, source);
      },
      openMove,
    });
    return () => {
      disposed = true;
      moveRequest()?.cancel();
      props.onReady(undefined);
    };
  });
  return (
    <>
      <Show when={peopleActive() ? props.header.mobilePeopleMentions?.activate : undefined} keyed>
        {(activate) => {
          onSettled(activate);
          return undefined;
        }}
      </Show>
      <Show when={cancelledMove()} keyed>
        {(request) => {
          onSettled(() => request.cancel());
          return undefined;
        }}
      </Show>
    </>
  );
}
