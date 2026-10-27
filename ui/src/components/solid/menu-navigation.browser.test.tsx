import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  item,
  mountMenu,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { MultiSelect } from "../multi-select.tsx";
import {
  controlInput,
  keyFocus as press,
  keyPhase,
  mountControls,
  submenu,
  tabFocus as tabTo,
  update,
} from "./menu-contract.test-support.tsx";
import { Menu, type MenuEntry, type MenuItem, type MenuProps } from "./menu.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";

afterEach(cleanup);

describe("Solid menu navigation", () => {
  it.each([true, "while-open"] as const)("owns lazy content across reopen (%s)", async (lazy) => {
    let itemReads = 0;
    let childrenReads = 0;
    const [label, setLabel] = createSignal("Ready");
    const [placement, setPlacement] = createSignal<"bottom-start" | "top-end">("bottom-start");
    const view = mountMenu({
      lazy,
      get placement() {
        return placement();
      },
      get items() {
        itemReads += 1;
        return [{ id: "ready", label: label() }];
      },
      get children() {
        childrenReads += 1;
        return <span>Lazy heading</span>;
      },
    });
    expect(itemReads).toBe(0);
    expect(childrenReads).toBe(0);
    const button = trigger();
    const panel = surface();
    expect(panel.querySelector("[role=menuitem]")).toBeNull();
    expect(button.style.getPropertyValue("anchor-name")).toBe("");
    expect(panel.style.getPropertyValue("position-anchor")).toBe("");
    update(() => setPlacement("top-end"));
    trigger().focus();
    await keyPhase("{ArrowDown}", "open");
    const ready = item("Ready");
    expect(document.activeElement).toBe(ready);
    expect(childrenReads).toBe(1);
    const anchorName = button.style.getPropertyValue("anchor-name");
    expect(anchorName).toMatch(/^--oc-overlay-/);
    expect(panel.style.getPropertyValue("position-anchor")).toBe(anchorName);
    expect(panel.dataset.placement).toBe("top-end");
    await keyPhase("{Escape}", "hidden");
    if (lazy === "while-open") {
      expect(panel.querySelector("[role=menuitem]")).toBeNull();
      update(() => setLabel("Updated"));
    }
    expect(view.handle.open()).toBe(true);
    await phase(surface(), "open");
    const current = item(lazy === true ? "Ready" : "Updated");
    expect(document.activeElement).toBe(current);
    if (lazy === true) {
      expect(current).toBe(ready);
      expect(childrenReads).toBe(1);
    }
    expect(button.style.getPropertyValue("anchor-name")).toBe(anchorName);
    view.unmount();
    expect(button.style.getPropertyValue("anchor-name")).toBe("");
  });

  it.each([false, true])("refuses lazy admission without active effects (veto %s)", (veto) => {
    const [open, setOpen] = createSignal(true);
    const changes: boolean[] = [];
    const view = mountMenu({
      lazy: true,
      get open() {
        return open();
      },
      onOpenChange: (accepted) => {
        changes.push(accepted);
        setOpen(accepted);
      },
      items: veto ? [{ id: "ready", label: "Ready" }] : [],
      onBeforeShow: (event) => {
        if (veto) {
          event.preventDefault();
        }
      },
    });
    expect(changes).toEqual([false]);
    update(() => setOpen(true));
    expect(changes).toEqual([false, false]);
    trigger().focus();
    expect(view.handle.open()).toBe(false);
    expect(surface().matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(openSurfaces()).toEqual([]);
  });

  it("navigates from search through grouped compound rows and custom controls", async () => {
    const selected: string[] = [];
    let pins = 0;
    const [revision, setRevision] = createSignal(0);
    mountControls((controls) => {
      const agentItems = (): MenuEntry[] => [
        {
          id: "alpha",
          label: "Alpha",
          as: "div",
          content: (
            <>
              Alpha
              <button
                ref={controls.ref()}
                data-form-control
                tabindex="-1"
                onClick={(event) => {
                  event.stopPropagation();
                  pins += 1;
                }}
              >
                Pin Alpha
              </button>
            </>
          ),
        },
        { id: "beta", label: revision() ? "Beta refreshed" : "Beta" },
      ];
      return {
        get items(): MenuEntry[] {
          return [
            {
              kind: "content",
              id: "search",
              content: controlInput(controls, "Find agent", { "data-search": "" }),
            },
            {
              kind: "group",
              id: "agents",
              render: (renderItems) => <div class="agent-list">{renderItems(agentItems)}</div>,
              items: agentItems(),
            },
            {
              id: "footer",
              label: "Footer",
              render: (attributes) => <button {...attributes}>Footer</button>,
            },
          ];
        },
        onSelect: (entry) => selected.push(entry.id),
      };
    });
    await openMenu();
    const group = surface().querySelector(".agent-list");
    const footer = item("Footer");
    const alpha = surface().querySelector<HTMLElement>('[data-value="alpha"]')!;
    alpha.focus();
    update(() => setRevision(1));
    expect(surface().querySelector(".agent-list")).toBe(group);
    expect(item("Footer")).toBe(footer);
    expect(document.activeElement).toBe(alpha);
    const search = surface().querySelector<HTMLInputElement>("input")!;
    search.focus();
    await press("{ArrowDown}", alpha);
    await tabTo(surface().querySelector("[data-form-control]")!);
    await tabTo(alpha, true);
    await press("{ArrowUp}", search);
    await press("{ArrowDown}{ArrowDown}", item("Beta refreshed"));
    await userEvent.click(surface().querySelector<HTMLButtonElement>("[data-form-control]")!);
    expect(pins).toBe(1);
    expect(selected).toEqual([]);
    await press("{ArrowDown}", item("Beta refreshed"));
    await keyPhase("{Enter}", "hidden");
    expect(selected).toEqual(["beta"]);
    await openMenu();
    item("Footer").focus();
    await keyPhase("{Enter}", "hidden");
    expect(selected).toEqual(["beta", "footer"]);
  });

  it("preserves native link intent, vetoes, and nested navigation to the root", async () => {
    const selected: string[] = [];
    const navigated: { href: string; value: string }[] = [];
    let veto = true;
    let parentContextMenus = 0;
    const links: MenuItem[] = [
      { id: "disabled", label: "Unavailable", href: "/new?agent=other", disabled: true },
      { id: "new", label: "New session", href: "/new?agent=main" },
    ];
    const view = mountMenu({
      items: [submenu("links", "Links", links)],
      onNavigate: (link) => navigated.push(link),
      onSelect: (entry, event) => {
        selected.push(entry.id);
        if (veto) {
          event.preventDefault();
        }
      },
    });
    view.container.addEventListener("contextmenu", (event) => {
      parentContextMenus++;
      event.preventDefault();
    });
    await openMenu();
    await openMenu("people-links");
    const menu = surface("people-links");
    const link = menu.querySelector<HTMLAnchorElement>('a[data-value="new"]')!;
    const disabled = menu.querySelector<HTMLAnchorElement>('a[data-value="disabled"]')!;
    expect(getComputedStyle(link).cursor).toBe("pointer");
    const mouse = (target: Element, type: string, init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const prevented: boolean[] = [];
    const stopNavigation = (event: MouseEvent) => {
      prevented.push(event.defaultPrevented);
      // Observe the menu's decision before suppressing browser navigation in this test.
      event.preventDefault();
    };
    window.addEventListener("click", stopNavigation);
    window.addEventListener("auxclick", stopNavigation);
    try {
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
        mouse(link, "click", { [modifier]: true });
      }
      mouse(link, "click", { button: 1 });
      mouse(link, "auxclick", { button: 1 });
      link.target = "_blank";
      mouse(link, "click");
      link.target = "";
      link.download = "session.txt";
      mouse(link, "click");
      link.removeAttribute("download");
      expect(prevented).toEqual(Array(8).fill(false));
      const canceledClick = new MouseEvent("click", { bubbles: true, cancelable: true });
      canceledClick.preventDefault();
      link.dispatchEvent(canceledClick);
      expect(prevented.at(-1)).toBe(true);
      expect(mouse(link, "contextmenu", { button: 2 }).defaultPrevented).toBe(false);
      expect(parentContextMenus).toBe(0);
      expect(selected).toEqual([]);
      expect(surface().matches(":popover-open")).toBe(true);
      expect(mouse(trigger(), "contextmenu").defaultPrevented).toBe(true);
      expect(parentContextMenus).toBe(1);
      expect(disabled.hasAttribute("href")).toBe(false);
      expect(disabled).toMatchObject({ ariaDisabled: "true", tabIndex: -1 });
      disabled.click();
      expect(selected).toEqual([]);
      await userEvent.click(link);
      expect(selected).toEqual(["new"]);
      expect(surface().matches(":popover-open")).toBe(true);
      link.focus();
      await userEvent.keyboard("{Enter}");
      expect(selected).toEqual(["new", "new"]);
      expect(surface().matches(":popover-open")).toBe(true);
      expect(navigated).toEqual([]);
      veto = false;
      await userEvent.click(link);
      expect(selected).toEqual(["new", "new", "new"]);
      expect(navigated).toEqual([{ href: "/new?agent=main", value: "new" }]);
      expect(prevented.at(-1)).toBe(true);
      await phase(surface(), "hidden");
    } finally {
      window.removeEventListener("click", stopNavigation);
      window.removeEventListener("auxclick", stopNavigation);
    }
  });

  it("owns Tab dismissal with caller-selected focus destinations", async () => {
    const credential = document.createElement("input");
    credential.value = "synthetic-key";
    let veto = true;
    const view = mountMenu({
      id: "provider",
      label: "Provider",
      items: [{ id: "beta", label: "Beta" }],
      tabFocusTarget: (backward) => (backward ? trigger("provider") : credential),
      onBeforeHide: (event) => {
        if (veto) {
          event.preventDefault();
        }
      },
    });
    view.container.append(credential);
    await openMenu("provider");
    await userEvent.tab();
    expect(surface("provider").matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(item("Beta", "provider"));
    veto = false;
    await userEvent.tab();
    await phase(surface("provider"), "hidden");
    expect(document.activeElement).toBe(credential);
    expect(credential.value).toBe("synthetic-key");
    await openMenu("provider");
    await userEvent.tab({ shift: true });
    await phase(surface("provider"), "hidden");
    expect(document.activeElement).toBe(trigger("provider"));
  });

  it("owns checkbox/radio selection, vetoes, and custom-trigger keyboard navigation", async () => {
    const [selected, setSelected] = createSignal("alpha");
    const [notified, setNotified] = createSignal(false);
    let veto = true;
    const choices = ["Alpha", "Beta", "Gamma"].map((label) => ({ id: label.toLowerCase(), label }));
    const view = mountMenu({
      get triggerAttributes(): MenuProps["triggerAttributes"] {
        return { id: "provider-trigger", "data-value": selected(), "aria-busy": "false" };
      },
      get items() {
        return [
          ...choices.map<MenuItem>((choice) => ({
            id: choice.id,
            label: choice.label,
            type: "radio",
            checked: choice.id === selected(),
            attributes: { "data-initial-focus": choice.id === selected() ? "" : undefined },
          })),
          {
            id: "notify",
            label: "Notify",
            type: "checkbox",
            checked: notified(),
            closeOnSelect: false,
          } satisfies MenuItem,
        ];
      },
      onSelect: (entry, event) => {
        if (veto) {
          event.preventDefault();
        } else if (entry.type === "checkbox") {
          setNotified((value) => !value);
        } else {
          setSelected(entry.id);
        }
      },
    });
    const button = view.getByRole("button", { name: "People" });
    expect(button).toMatchObject({ id: "provider-trigger", ariaBusy: "false" });
    expect(button.getAttribute("aria-controls")).toBe(surface().id);
    expect(surface().getAttribute("aria-labelledby")).toBe("provider-trigger");
    button.focus();
    await keyPhase("{Enter}", "open");
    expect(document.activeElement).toBe(item("Alpha"));
    await userEvent.click(item("Beta"));
    expect(item("Beta").getAttribute("aria-checked")).toBe("false");
    expect(surface().matches(":popover-open")).toBe(true);
    veto = false;
    await userEvent.click(item("Notify"));
    flush();
    expect(item("Notify").getAttribute("aria-checked")).toBe("true");
    expect(surface().matches(":popover-open")).toBe(true);
    item("Alpha").focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    flush();
    await phase(surface(), "hidden");
    expect(button.getAttribute("data-value")).toBe("beta");
    expect(document.activeElement).toBe(button);
    await keyPhase("{Enter}", "open");
    expect(item("Beta").getAttribute("aria-checked")).toBe("true");
    expect(item("Alpha").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(item("Beta"));
    await press("{Home}", item("Alpha"));
    await press("{End}", item("Notify"));
    await keyPhase("{Escape}", "hidden");
    expect(document.activeElement).toBe(button);
    await keyPhase("{ArrowUp}", "open");
    expect(document.activeElement).toBe(item("Notify"));
    await press("{Home}g", item("Gamma"));
    expect(item("Gamma").tabIndex).toBe(0);
    expect(surface().hasAttribute("aria-activedescendant")).toBe(false);
    await keyPhase("{Enter}", "hidden");
    expect(button.getAttribute("data-value")).toBe("gamma");
  });

  it.each([
    ["ltr", false],
    ["rtl", false],
    ["rtl", true],
  ] as const)("preserves live %s sibling navigation (reopen=%s)", async (dir, reopen) => {
    const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
    mountMenu({
      get dir() {
        return direction();
      },
    });
    if (reopen) {
      await openMenu();
      trigger("people-assign").focus();
      await keyPhase("{ArrowRight}", "open", "people-assign");
      await keyPhase("{ArrowLeft}{Escape}", "hidden");
    }
    update(() => setDirection(dir));
    await openMenu();
    trigger("people-assign").focus();
    await keyPhase(dir === "ltr" ? "{ArrowRight}" : "{ArrowLeft}", "open", "people-assign");
    expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
    trigger("people-move").focus();
    await userEvent.keyboard(dir === "ltr" ? "{ArrowRight}" : "{ArrowLeft}");
    await phase(surface("people-move"), "open");
    await phase(surface("people-assign"), "hidden");
    expect(document.activeElement).toBe(item("Engineering", "people-move"));
    await press(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}", trigger("people-move"));
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(item("Archive"));
    await press("{Home}", trigger("people-assign"));
    await phase(surface("people-move"), "hidden");
    expect(openSurfaces()).toEqual([surface()]);
  });

  it("clears search before closing the deepest branch and restores each trigger", async () => {
    mountControls((controls) => ({
      items: [
        {
          id: "search",
          label: "Find person",
          children: [{ id: "ada", label: "Ada" }],
          content: controlInput(controls, "Search people", {
            "data-search": "",
            "data-initial-focus": "",
          }),
        },
      ],
    }));
    await openMenu();
    await openMenu("people-search");
    const search = surface("people-search").querySelector("input")!;
    expect(document.activeElement).toBe(search);
    await userEvent.fill(search, "Grace");
    await userEvent.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(surface("people-search").matches(":popover-open")).toBe(true);
    await keyPhase("{Escape}", "hidden", "people-search");
    expect(surface().matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(trigger("people-search"));
    await keyPhase("{Escape}", "hidden");
    expect(document.activeElement).toBe(trigger());
  });

  it("traverses rows and eligible controls while preserving editing and native Tab exit", async () => {
    const view = mountControls((controls) => {
      const input = (label: string, props: Parameters<typeof controlInput>[2] = {}) =>
        controlInput(controls, label, { "data-form-control": "", ...props });
      const button = (label: string, props: JSX.ButtonHTMLAttributes<HTMLButtonElement> = {}) => (
        <button ref={controls.ref()} data-form-control="" {...props}>
          {label}
        </button>
      );
      return {
        items: [
          { id: "before", label: "Before settings" },
          {
            kind: "content",
            id: "settings",
            content: (
              <>
                {controlInput(controls, "Filter settings", { "data-search": "" })}
                {button("Default")}
                {button("Disabled", { disabled: true })}
                {button("Unavailable", { "aria-disabled": "true" })}
                {input("Hidden attribute", { hidden: true })}
                {input("", { type: "hidden" })}
                <span style={{ visibility: "hidden" }}>{input("Invisible")}</span>
                <span ref={controls.ref()} data-form-control="">
                  Not focusable
                </span>
                {button("Not sequential", { tabindex: -1 })}
                <div inert>{input("Inert control")}</div>
                {button("Coral")}
                {input("Custom icon")}
              </>
            ),
          },
          { id: "after", label: "After settings" },
        ],
      };
    });
    await openMenu();
    const first = view.getByRole("button", { name: "Default" });
    const second = view.getByRole("button", { name: "Coral" });
    const input = view.getByRole("textbox", { name: "Custom icon" }) as HTMLInputElement;
    const search = view.getByRole("textbox", { name: "Filter settings" });
    item("Before settings").focus();
    await tabTo(search);
    await tabTo(first);
    await tabTo(second);
    await tabTo(first, true);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(input);
    await tabTo(item("After settings"));
    await tabTo(input, true);
    await tabTo(second, true);
    await tabTo(first, true);
    await tabTo(search, true);
    await tabTo(item("Before settings"), true);
    input.focus();
    await userEvent.fill(input, "abc");
    await userEvent.keyboard("{ArrowLeft}X");
    expect(input.value).toBe("abXc");
    await keyPhase("{Escape}", "hidden");
    await openMenu();
    expect(view.getByRole("textbox", { name: "Custom icon" })).toBe(input);
    expect(input.value).toBe("abXc");
    input.focus();
    await tabTo(item("After settings"));
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });

  it("keeps Tab in the current menu when a descendant menu has visible controls", async () => {
    let veto = true;
    const view = mountControls((controls) => ({
      items: [],
      children: (
        <>
          {controlInput(controls, "First control", { "data-form-control": "" })}
          <Menu
            id="nested-controls"
            label="Nested controls"
            items={[]}
            controls={controls}
            onBeforeHide={(event) => {
              if (veto) {
                event.preventDefault();
              }
            }}
          >
            {controlInput(controls, "Descendant control", { "data-form-control": "" })}
          </Menu>
          {controlInput(controls, "Last control", { "data-form-control": "" })}
        </>
      ),
    }));
    await openMenu();
    await openMenu("nested-controls");
    const first = view.getByRole("textbox", { name: "First control" });
    const last = view.getByRole("textbox", { name: "Last control" });
    first.focus();
    expect(surface("nested-controls").matches(":popover-open")).toBe(true);
    await tabTo(last);
    await tabTo(first, true);
    veto = false;
    last.focus();
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });
});

function mountColdMenu(options: Partial<MenuProps> = {}, open = true) {
  const selections: string[] = [];
  const view = mountMenu({
    lazy: true,
    items: ["Alpha", "Beta", "Gamma"].map((label) => ({ id: label.toLowerCase(), label })),
    onSelect: (entry) => selections.push(entry.id),
    ...options,
  });
  const { handle } = view;
  const button = trigger(),
    panel = surface();
  if (open) {
    expect(handle.open()).toBe(true);
  }
  const row = (id: string) => panel.querySelector<HTMLElement>(`[data-value="${id}"]`)!;
  return { view, handle, button, panel, row, selections };
}

function coldKey(target: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("defers cold button pointer focus until click without suppressing context menus", () => {
  const { handle, button } = mountColdMenu({}, false);
  const down = (mouseButton: number) => {
    const event = new PointerEvent("pointerdown", {
      button: mouseButton,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event;
  };
  expect(down(0).defaultPrevented).toBe(true);
  expect(handle.overlay.open).toBe(false);
  expect(down(2).defaultPrevented).toBe(false);
  button.click();
  expect(handle.overlay.open).toBe(true);
});

it("queues retained-focus input navigation outside the listbox during first load", async () => {
  const selections: string[][] = [];
  const view = render(() => (
    <MultiSelect
      accessibleLabel="Choices"
      options={[
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ]}
      onChange={(values) => selections.push(values)}
    />
  ));
  flush();
  const input = view.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const panel = view.container.querySelector('[role="listbox"]')!;
  input.focus();
  coldKey(input, "ArrowDown");
  flush();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(panel.contains(input)).toBe(false);
  expect(coldKey(input, "ArrowDown").defaultPrevented).toBe(true);
  expect(coldKey(input, "Enter").defaultPrevented).toBe(true);
  await expect.poll(() => selections).toEqual([["beta"]]);
  expect(document.activeElement).toBe(input);
});

it.each([
  { keys: ["ArrowDown", "ArrowDown"], focused: "gamma", selected: [] },
  { keys: ["ArrowDown", "Enter"], focused: null, selected: ["beta"] },
  { keys: ["End", "Enter"], focused: null, selected: ["gamma"] },
])("replays queued $keys in navigation order", async ({ keys, focused, selected }) => {
  const { row, selections } = mountColdMenu();
  const first = row("alpha");
  for (const value of keys) {
    coldKey(first, value);
  }
  if (focused) {
    await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe(focused);
  } else {
    await expect.poll(() => selections).toEqual(selected);
  }
});

it.each(["Enter", " "])(
  "commits a focused cold leaf with %j before immediate overlay close",
  (value) => {
    const { handle, row, selections } = mountColdMenu();
    const target = row("beta");
    target.focus();
    expect(coldKey(target, value).defaultPrevented).toBe(true);
    handle.close();
    expect(selections).toEqual(["beta"]);
  },
);

it("continues from the entry row when focus returns to the button during first load", async () => {
  const { button, row } = mountColdMenu();
  expect(document.activeElement).toBe(row("alpha"));
  button.focus();
  expect(coldKey(button, " ").defaultPrevented).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
});

it("leaves native control activation keys unhandled during first load", () => {
  const { panel } = mountColdMenu({
    children: (["button", "a", "input", "textarea", "select"] as const).map((tag) => {
      const control = document.createElement(tag);
      control.dataset.formControl = "";
      if (control instanceof HTMLAnchorElement) {
        control.href = "#native-control";
      }
      if (control instanceof HTMLSelectElement) {
        control.add(new Option("Native option"));
      }
      return control;
    }),
  });
  for (const control of panel.querySelectorAll<HTMLElement>("[data-form-control]")) {
    control.focus();
    expect(coldKey(control, "Enter").defaultPrevented).toBe(false);
    expect(coldKey(control, " ").defaultPrevented).toBe(false);
  }
});

it("bubbles parent navigation from an open submenu button during first load", async () => {
  const { handle } = mountColdMenu({
    items: [
      { id: "group", label: "Group", children: [{ id: "nested", label: "Nested" }] },
      { id: "next", label: "Next" },
    ],
  });
  flush();
  const child = [...handle.overlay.children][0]!;
  expect(child.request(true, "none")).toBe(true);
  child.trigger!.focus();
  coldKey(child.trigger!, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("next");
});

it("leaves Escape to the open child when focus stays on its cold parent button", () => {
  let help!: PopoverHandle;
  const [showHelp, setShowHelp] = createSignal(false);
  const { handle } = mountColdMenu({
    children: (
      <Show when={showHelp()}>
        <Popover id="cold-help" label="Help" ref={(value) => (help = value)}>
          Menu help
        </Popover>
      </Show>
    ),
  });
  setShowHelp(true);
  flush();
  expect(help.overlay.parent).toBe(handle.overlay);
  expect(help.show()).toBe(true);
  help.overlay.trigger!.focus();

  // No await: the navigation import cannot settle before the first Escape.
  expect(coldKey(help.overlay.trigger!, "Escape").defaultPrevented).toBe(true);
  expect(help.overlay.open).toBe(false);
  expect(handle.overlay.open).toBe(true);
  expect(document.activeElement).toBe(help.overlay.trigger);

  coldKey(help.overlay.trigger!, "Escape");
  expect(handle.overlay.open).toBe(false);
});

it("admits and focuses synchronously, retires old keys, and replays input after first load", async () => {
  const { handle, button, row } = mountColdMenu();
  const first = row("alpha");
  expect(document.activeElement).toBe(first);
  coldKey(first, "g");
  expect(handle.close()).toBe(true);
  expect(handle.open()).toBe(true);
  coldKey(first, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
  coldKey(document.activeElement!, "g");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(handle.close()).toBe(true);
  coldKey(button, "ArrowUp");
  await expect.poll(() => handle.overlay.open).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(row("alpha")).toBe(first);
});

it("does not reopen a disposed owner after loading", async () => {
  const { view, handle } = mountColdMenu();
  view.unmount();
  await Promise.resolve();
  expect(handle.overlay.open).toBe(false);
  expect(document.querySelector(":popover-open")).toBeNull();
});
