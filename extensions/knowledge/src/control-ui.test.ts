/* @vitest-environment jsdom */

import type * as UI from "openclaw/plugin-sdk/control-ui";
import { expect, it, onTestFinished, vi } from "vitest";
import plugin from "./control-ui.js";

// Backend answers for the first screens; shapes follow the knowledge contract.
const answers: Record<string, unknown> = {
  stores_snapshot: {
    revision: "r1",
    grants: { revision: "g1", entries: [] },
    defaultAgent: "main",
    agents: [{ id: "main", name: "Main", supported: true, binding: "brain" }],
    stores: [
      {
        binding: "brain",
        kind: "named",
        label: "Brain",
        members: ["main"],
        retained: false,
        state: "ready",
        records: 410,
      },
    ],
    canChange: true,
    issues: [],
  },
  status: { agent: "main", vault: "vault-1", scope: "private", store: "ready", snapshot: "s1" },
  ontology: {
    view: "catalog",
    fingerprint: "f1",
    nextOffset: null,
    definitions: [{ name: "person", label: "Person", primitive: "entity", recordCount: 410 }],
  },
  recent: { items: [], upperSequence: 0, nextBefore: null },
  records: { records: [], total: 0, offset: 0, nextOffset: null },
};

// Mounts the Knowledge page on a fake host. `hold` delays the next answer to an action
// (or to the Scribes count's automation list) until the test releases it; `initial` holds
// apply from the first request the mount sends.
function mount(initial: string[] = [], failing: string[] = []) {
  const calls: string[] = [];
  const held = new Map<string, PromiseWithResolvers<void>>();
  const hold = (name: string) => {
    const gate = Promise.withResolvers<void>();
    held.set(name, gate);
    return () => gate.resolve();
  };
  const releases = Object.fromEntries(initial.map((name) => [name, hold(name)]));
  const wait = async (name: string) => {
    const gate = held.get(name);
    held.delete(name);
    await gate?.promise;
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "plugins.sessionAction") {
      const action = String(params?.actionId);
      calls.push(action);
      await wait(action);
      return failing.includes(action)
        ? { ok: false, error: `${action} failed` }
        : { ok: true, result: answers[action] };
    }
    calls.push(method);
    if (method === "cron.list") {
      await wait("scribes");
      return { jobs: [] };
    }
    return method === "sessions.list" ? { sessions: [] } : {};
  });
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    pluginId: "knowledge",
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: false, canAdmin: false },
    redact: (text: string) => text,
    request,
    onEvent: () => () => {},
    subscribe: () => () => {},
    agents: { rows: [{ id: "main", name: "Main" }], selectedId: "main" },
    navigation: { openPage: vi.fn(), pageHref: () => "#" },
    ui: { registerPage, registerNavigation: () => () => {}, registerPanel: () => () => {} },
  } as unknown as UI.ControlUiHost;
  void plugin.activate(host);
  const [page] = registerPage.mock.calls[0]!;
  const view = page.mount(document.body, {
    host,
    props: {},
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  });
  onTestFinished(() => {
    controller.abort();
    view?.dispose?.();
    document.body.replaceChildren();
  });
  const tab = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".knowledge-tab")].find((node) =>
      node.textContent!.startsWith(name),
    )!;
  return { calls, hold, releases, tab };
}

const content = () => document.querySelector<HTMLElement>(".knowledge-content")!;

it("starts store facts and status together and settles the header and tab counts at once", async () => {
  const { calls, releases, tab } = mount(["stores_snapshot", "status", "ontology", "scribes"]);
  const page = document.querySelector(".knowledge-page")!;
  await vi.waitFor(() => expect(calls.toSorted()).toEqual(["status", "stores_snapshot"]));
  // Nothing claims to be connecting, and default copy is not shown before the agent is known.
  expect(document.querySelector<HTMLElement>(".knowledge-status")!.hidden).toBe(true);
  expect(page.classList.contains("knowledge-copy-pending")).toBe(true);
  expect(tab("Browse").querySelector(".knowledge-tab-count-pending")).not.toBeNull();
  expect(tab("Scribes").querySelector(".knowledge-tab-count-pending")).not.toBeNull();

  releases.stores_snapshot!();
  releases.status!();
  await vi.waitFor(() => expect(calls).toContain("ontology"));
  expect(calls).toContain("cron.list");
  expect(page.classList.contains("knowledge-copy-pending")).toBe(false);
  expect(document.querySelector(".knowledge-subtitle")!.textContent).toBe(
    "Knowledge saved here, and where it came from.",
  );

  // The page total waits for the Scribes count so both tabs change in one layout pass.
  releases.ontology!();
  await vi.waitFor(() => expect(calls).toContain("recent"));
  expect(tab("Browse").textContent).toBe("Browse");
  expect(tab("Browse").querySelector(".knowledge-tab-count-pending")).not.toBeNull();
  releases.scribes!();
  await vi.waitFor(() => expect(tab("Browse").textContent).toBe("Browse410"));
  expect(tab("Scribes").textContent).toBe("Scribes");
  expect(document.querySelector(".knowledge-tab-count-pending")).toBeNull();
});

it("shows a tab's last view again while it refreshes on return", async () => {
  const { hold, tab } = mount();
  await vi.waitFor(() => expect(content().textContent).toContain("No recent activity"));
  tab("Browse").click();
  await vi.waitFor(() => expect(content().textContent).toContain("Nothing here yet"));

  const releaseRecent = hold("recent");
  tab("Recent").click();
  expect(content().textContent).toContain("No recent activity");
  expect(content().querySelector(".knowledge-placeholder")).toBeNull();
  expect(content().querySelector<HTMLElement>(".knowledge-view-data")!.inert).toBe(true);
  releaseRecent();
  await vi.waitFor(() =>
    expect(content().querySelector<HTMLElement>(".knowledge-view-data")!.inert).toBe(false),
  );
  expect(content().textContent).toContain("No recent activity");
});

it("keeps a failed page total out of the view's outcome", async () => {
  const { tab } = mount([], ["ontology"]);
  await vi.waitFor(() => expect(content().textContent).toContain("No recent activity"));
  await vi.waitFor(() => expect(document.querySelector(".knowledge-tab-count-pending")).toBeNull());
  expect(document.querySelector<HTMLElement>(".knowledge-status")!.hidden).toBe(true);
  expect(content().querySelector(".knowledge-error")).toBeNull();
  expect(tab("Browse").textContent).toBe("Browse");
});

it("gives Browse its page types before the Scribes count arrives", async () => {
  const { releases } = mount(["scribes"]);
  await vi.waitFor(() => expect(content().textContent).toContain("No recent activity"));
  [...document.querySelectorAll<HTMLButtonElement>(".knowledge-tab")]
    .find((node) => node.textContent!.startsWith("Browse"))!
    .click();
  await vi.waitFor(() => expect(content().textContent).toContain("Nothing here yet"));
  expect(content().querySelector('[data-facet="person"]')).not.toBeNull();
  releases.scribes!();
});
