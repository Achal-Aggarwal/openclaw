/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { createActiveSessionPlacement } from "../../../test-helpers/session-placement.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatMobileHostFixture } from "../chat-mobile-host.test-support.ts";
import {
  chatPaneHeaderSessionMenu,
  chatPaneHeaderSessionRow,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";

const loading = vi.hoisted(() => ({
  ...Promise.withResolvers<void>(),
  entered: false,
}));
vi.mock("./chat-pane-mobile-runtime.tsx", async (original) => {
  loading.entered = true;
  await loading.promise;
  return original();
});

it("retains the latest mobile navigation during loading and drops retired pane intents", async () => {
  onTestFinished(() => loading.resolve());
  const containers: HTMLElement[] = [];
  onTestFinished(() => containers.forEach((container) => container.remove()));
  function mountPendingHeader(id: string) {
    const detailsMount = document.createElement("div");
    document.body.append(detailsMount);
    containers.push(detailsMount);
    const session = chatPaneHeaderSessionRow({
      key: `agent:main:${id}`,
      placement: createActiveSessionPlacement(),
    });
    const host = createChatMobileHostFixture(id, {
      detailsMount,
      mode: "expanded",
      open: true,
      destination: { area: "details" },
    });
    const detailsControl: NonNullable<ChatPaneHeaderProps["detailsControl"]> = {
      chat: {
        sessionKey: session.key,
        currentAgentId: "main",
        selectedSession: session,
        messages: [],
        gatewayScope: {},
      },
      elements: {},
      mobile: true,
      nativePresentation: "mobile",
      mobileHost: host,
      presentation: true,
      setRef: vi.fn(),
    };
    const onMove = vi.fn<NonNullable<ChatPaneHeaderProps["onMobilePlacementMove"]>>(
      async (present) => {
        present({
          title: "Move session",
          render: () => <p>Choose destination</p>,
          cancel: vi.fn(),
        });
      },
    );
    const sessionMenuAction = chatPaneHeaderSessionMenu();
    const header = mountChatPaneHeader(containers, {
      paneId: id,
      mergedChrome: true,
      session,
      placementControl: { session },
      detailsControl,
      onMobilePlacementMove: onMove,
      mobilePeople: {
        header: [
          { key: "ada", sender: { name: "Ada" }, label: "Ada", firstName: "Ada", viewing: true },
        ],
        viewers: [],
        participants: [],
        unlistedParticipantCount: 0,
        participantsComplete: false,
      },
      sessionMenuAction: {
        ...sessionMenuAction,
        session: {
          ...sessionMenuAction.session,
          placementAction: "move",
          target: { key: session.key },
        },
      },
    });
    return Object.assign(header, { host, detailsControl, onMove });
  }
  const people = mountPendingHeader("early-people");
  const machine = mountPendingHeader("early-machine");
  const move = mountPendingHeader("early-move");
  const replaced = mountPendingHeader("replaced-host");
  const switched = mountPendingHeader("switched-session");
  const desktop = mountPendingHeader("retired-mobile");
  const hidden = mountPendingHeader("hidden-pane");
  const headers = [people, machine, move, replaced, switched, desktop, hidden];
  const peopleButton = (header: typeof people) =>
    header.container.querySelector<HTMLButtonElement>(".chat-mobile-people-grid");
  const machineButton = () =>
    machine.host.detailsMount?.querySelector<HTMLButtonElement>(
      ".chat-environment-mobile__row .chat-environment__action",
    );
  await waitForSolid(
    () => {
      expect(loading.entered).toBe(true);
      for (const header of headers) {
        expect(peopleButton(header)).not.toBeNull();
      }
      expect(machineButton()).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  peopleButton(people)!.click();
  // The second destination replaces People while preserving this shared Details owner.
  peopleButton(machine)!.click();
  machineButton()!.click();
  const menu = move.container.querySelector("openclaw-chat-header-session-menu")!;
  menu.querySelector<HTMLButtonElement>(".oc-menu-trigger")!.click();
  await waitForSolid(
    () =>
      expect(
        menu.querySelector<HTMLButtonElement>('button[data-value="move-session"]'),
        "Move is available while destination code is held",
      ).not.toBeNull(),
    { timeout: 10_000 },
  );
  const moveButton = menu.querySelector<HTMLButtonElement>('button[data-value="move-session"]')!;
  expect(moveButton.disabled).toBe(false);
  moveButton.click();
  for (const header of [replaced, switched, desktop, hidden]) {
    peopleButton(header)!.click();
  }
  const nextHost = createChatMobileHostFixture("next-host");
  replaced.update({ detailsControl: { ...replaced.detailsControl, mobileHost: nextHost } });
  switched.update({ session: chatPaneHeaderSessionRow({ key: "agent:main:next-session" }) });
  desktop.update({ mergedChrome: false });
  hidden.update({ presented: false });
  for (const header of headers) {
    expect(header.host.navigate).not.toHaveBeenCalled();
    expect(header.onMove).not.toHaveBeenCalled();
  }

  loading.resolve();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(people.host.navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: expect.objectContaining({ key: "people" }) }),
      peopleButton(people),
    );
    expect(machine.host.navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: expect.objectContaining({ key: "machine" }) }),
      undefined,
    );
    expect(move.onMove).toHaveBeenCalledOnce();
    expect(move.host.navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page: expect.objectContaining({ key: "machine-move" }) }),
    );
  });
  for (const header of [replaced, switched, desktop, hidden]) {
    expect(header.host.navigate).not.toHaveBeenCalled();
    expect(header.onMove).not.toHaveBeenCalled();
  }
  expect(nextHost.navigate).not.toHaveBeenCalled();
  expect(move.props.sessionMenuAction?.onAction).not.toHaveBeenCalled();
});
