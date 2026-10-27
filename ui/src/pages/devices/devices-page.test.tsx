/* @vitest-environment jsdom */

import type { EnvironmentSummary, SystemInfoResult } from "@openclaw/gateway-protocol";
import { getQueriesForElement } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { PresenceEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  beginConfigRead,
  invalidateConfigConnection,
} from "../../lib/config/config-state-model.ts";
import {
  deviceSystemInfo,
  deviceDesktopEnvironments,
} from "../../test-helpers/devices-fixtures.ts";
import { missingReadScopeErrorFixture } from "../../test-helpers/gateway-client.ts";
import { waitForRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  gatewaySnapshot,
  gatewayFixture,
  mountPage,
  responseFor,
  clientFor,
  button,
  dialogButton,
  selectEntryAction,
  secretDialogText,
  expectNoModal,
  mountPaired,
  rotatingRequest,
  stubLocalDeviceIdentity,
  dialogs,
  setupDevicesPageFixtures,
} from "./devices-page.test-support.tsx";

const ROTATED_TOKEN = "rotated-operator-token";
type Page = ReturnType<typeof mountPage>;
const query = <T extends Element = Element>(page: Page, selector: string) =>
  page.container.querySelector<T>(selector);
const pageText = (page: Page) => page.container.textContent;
const modalQuery = (selector: string) => document.body.querySelector(selector);
const methodsCalled = (request: ReturnType<typeof clientFor>["request"]) =>
  request.mock.calls.map(([method]) => method);
const callsTo = (request: ReturnType<typeof clientFor>["request"], name: string) =>
  request.mock.calls.filter(([method]) => method === name);
const settle = async () => {
  await Promise.resolve();
  flush();
};
async function openRotation(token: string | null) {
  stubLocalDeviceIdentity();
  const page = mountPaired(rotatingRequest(token));
  button(page.container, t("devices.inventory.rotate")).click();
  return waitForRenderedModalDialog(document.body);
}
const dismissalEvent = () =>
  new Event("modal-cancel", { bubbles: true, cancelable: true, composed: true });
function mountConnected(
  request?: Parameters<typeof clientFor>[0],
  initial: Parameters<typeof mountPage>[1] = {},
  methods: string[] = [],
  scopes?: string[],
) {
  const connection = clientFor(request);
  const snapshot = gatewaySnapshot(connection.client, true, methods, scopes);
  const fixture = gatewayFixture(snapshot);
  return { ...mountPage(fixture, initial), ...connection, snapshot, fixture };
}
function replying(methodName: string, reply: () => unknown) {
  return clientFor(
    vi.fn(async (method: string) => (method === methodName ? reply() : responseFor(method))),
  );
}

describe("DevicesPage gateway lifecycle", () => {
  setupDevicesPageFixtures();

  it("names the page with a level-one heading", () => {
    const page = mountPage(gatewayFixture(gatewaySnapshot(clientFor().client)));
    expect(
      getQueriesForElement(page.container).getByRole("heading", { level: 1 }).textContent,
    ).toBe("Devices");
  });

  it("keeps inventory usable and retires a held approval read on Gateway replacement", async () => {
    const policyMethod = "exec.approvals.get";
    const pending = createDeferred<unknown>();
    const { client, request } = replying(policyMethod, () => pending.promise);
    const page = mountPage(gatewayFixture(gatewaySnapshot(client, true, [], ["operator.admin"])), {
      nodes: [{ nodeId: "available", displayName: "Available node" }],
    });
    await waitForSolid(() => expect(pageText(page)).toContain("Available node"));
    expect(query(page, 'select[aria-label="Mode"]')).toBeNull();
    expect(button(page.container, t("common.loading")).disabled).toBe(true);
    expect(callsTo(request, policyMethod)).toHaveLength(1);

    const replacement = clientFor();
    page.replaceGateway(
      gatewayFixture(gatewaySnapshot(replacement.client, true, [], ["operator.admin"])),
    );
    await waitForSolid(() => expect(query(page, 'select[aria-label="Mode"]')).not.toBeNull());
    pending.reject(new Error("Retired read"));
    await waitForSolid(() => expect(pageText(page)).not.toContain("Retired read"));
  });

  it("surfaces the shared config read failure and retries through its owner", async () => {
    const page = mountConnected(undefined, {}, [], ["operator.admin"]);
    const { client } = page;
    page.config.configSnapshot = null;
    page.config.configForm = null;
    const read = beginConfigRead(page.config, client);
    read.completion.resolve({ ok: false, error: "Config failed" });
    page.publishConfig();
    await waitForSolid(() => expect(pageText(page)).toContain("Config failed"));
    button(page.container, t("common.retry")).click();
    expect(page.reloadConfig).toHaveBeenCalledExactlyOnceWith({ reloadOnly: true });
    const retry = beginConfigRead(page.config, client);
    retry.completion.resolve({ ok: true, value: undefined });
    page.publishConfig();
    await waitForSolid(() => expect(pageText(page)).not.toContain("Config failed"));
  });

  it.each(["reload", "reconnect"])(
    "retains editable bindings after a failed %s",
    async (reason) => {
      const page = mountConnected(
        undefined,
        {
          nodes: [{ nodeId: "draft-node", commands: ["system.run"] }],
        },
        [],
        ["operator.admin"],
      );
      const { client, snapshot, fixture } = page;
      page.config.configForm = { tools: { exec: { node: "draft-node" } } };
      page.config.configFormDirty = true;
      page.publishConfig();
      const queries = getQueriesForElement(page.container);
      await waitForSolid(() =>
        expect(queries.getByRole("combobox", { name: "Node" })).toHaveProperty("disabled", false),
      );
      const binding = queries.getByRole("combobox", { name: "Node" });
      if (reason === "reconnect") {
        invalidateConfigConnection(page.config);
        fixture.emitSnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        fixture.emitSnapshot(snapshot);
      }
      page.config.configLoading = true;
      const read = beginConfigRead(page.config, client);
      page.publishConfig();
      await waitForSolid(() => expect(binding).toHaveProperty("disabled", true));
      page.config.configLoading = false;
      read.completion.resolve({ ok: false, error: "Config failed" });
      page.publishConfig();
      await waitForSolid(() => {
        expect(queries.getByRole("combobox", { name: "Node" })).toBe(binding);
        expect(binding).toHaveProperty("value", "draft-node");
        expect(binding).toHaveProperty("disabled", false);
        expect(page.config.configFormDirty).toBe(true);
        expect(queries.queryByRole("button", { name: t("common.retry") })).toBeNull();
      });
    },
  );

  it("preserves matching route data, then clears inventory on provider replacement", async () => {
    const fixture = gatewayFixture(gatewaySnapshot(null, false));
    const page = mountPage(fixture, {
      nodes: [{ nodeId: "preloaded", displayName: "Preloaded Mac" }],
    });
    await waitForSolid(() => expect(pageText(page)).toContain("Preloaded Mac"));
    fixture.emitEvent("presence", {
      presence: [{ host: "Stale presence", instanceId: "stale", ts: 1_000 }],
    });
    await waitForSolid(() => expect(pageText(page)).toContain("Stale presence"));
    page.replaceGateway(gatewayFixture(gatewaySnapshot(null, false)));
    await waitForSolid(() => {
      expect(pageText(page)).not.toContain("Preloaded Mac");
      expect(pageText(page)).not.toContain("Stale presence");
    });
  });

  it("retains inventory and an edited approval policy through a same-client reconnect", async () => {
    const page = mountConnected(
      undefined,
      {
        nodes: [{ nodeId: "retained", displayName: "Retained Mac" }],
        execApprovalsSnapshot: {
          path: "/synthetic/exec-approvals.json",
          exists: true,
          hash: "original-base",
          file: { version: 1, defaults: { security: "deny" } },
        },
        execApprovalsForm: { version: 1, defaults: { security: "deny" } },
      },
      [],
      ["operator.admin"],
    );
    const { snapshot, fixture } = page;
    await waitForSolid(() => expect(query(page, 'select[aria-label="Mode"]')).not.toBeNull());
    const policy = query<HTMLSelectElement>(page, 'select[aria-label="Mode"]')!;
    expect(policy).not.toBeNull();
    policy.value = "allowlist";
    policy.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    page.config.configForm = { tools: { exec: { node: "draft-node" } } };
    page.publishConfig();
    await waitForSolid(() =>
      expect(query<HTMLSelectElement>(page, 'select[aria-label="Node"]')?.value).toBe("draft-node"),
    );
    invalidateConfigConnection(page.config);
    fixture.emitSnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    expect(pageText(page)).toContain("Retained Mac");
    expect(query<HTMLSelectElement>(page, 'select[aria-label="Mode"]')?.value).toBe("allowlist");
    expect(button(page.container, "Save").disabled).toBe(true);
    expect(query<HTMLSelectElement>(page, 'select[aria-label="Node"]')?.value).toBe("draft-node");
    fixture.emitSnapshot(snapshot);
    expect(query<HTMLSelectElement>(page, 'select[aria-label="Mode"]')?.value).toBe("allowlist");
    page.replaceGateway(gatewayFixture(gatewaySnapshot(null, false)));
    await waitForSolid(() => {
      expect(pageText(page)).not.toContain("Retained Mac");
      expect(query(page, 'select[aria-label="Mode"]')).toBeNull();
    });
  });

  it("rejects preloaded data after a same-client gateway epoch change", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(gatewaySnapshot(client));
    const page = mountPage(
      fixture,
      { nodes: [{ nodeId: "stale", displayName: "Stale Mac" }] },
      {
        gatewaySnapshot: gatewaySnapshot(client, false),
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    expect(pageText(page)).not.toContain("Stale Mac");
  });

  it.each(["node.runnerInventory.changed", "node.hostStats"])(
    "quietly reloads node status for %s",
    async (event) => {
      const nodes = createDeferred<{ nodes: Array<Record<string, unknown>> }>();
      const { client, request } = replying("node.list", () => nodes.promise);
      const fixture = gatewayFixture(gatewaySnapshot(client));
      const page = mountPage(fixture, {
        nodes: [{ nodeId: "node-1", displayName: "Office Mac", connected: false }],
        devicesList: { paired: [], pending: [] },
        lastError: "Earlier operator action failed",
      });
      const row = [...page.container.querySelectorAll(".device-entry")].find((entry) =>
        entry.textContent?.includes("Office Mac"),
      );
      expect(row).toBeDefined();
      fixture.emitEvent(event, { nodeId: "node-1" });
      expect(request).toHaveBeenCalledWith("node.list", {});
      expect(pageText(page)).toContain("Office Mac");
      expect(row?.isConnected).toBe(true);
      expect(pageText(page)).toContain("Earlier operator action failed");
      nodes.resolve({ nodes: [{ nodeId: "node-1", displayName: "Current Mac", connected: true }] });
      await vi.waitFor(() => expect(pageText(page)).toContain("Current Mac"));
      const refreshedRow = [...page.container.querySelectorAll(".device-entry")].find((entry) =>
        entry.textContent?.includes("Current Mac"),
      );
      page.refreshPresentation();
      expect(refreshedRow?.isConnected).toBe(true);
      expect(pageText(page)).toContain("Current Mac");
      expect(pageText(page)).not.toContain("Office Mac");
    },
  );

  it.each<
    [
      name: string,
      methods: string[] | undefined,
      scopes: string[] | undefined,
      read: boolean,
      systemInfo: boolean,
      desktop: boolean,
    ]
  >([
    ["advertised", ["system.info", "desktop.observe"], ["operator.admin"], true, true, true],
    ["unadvertised", [], undefined, true, false, false],
    ["unknown features", undefined, undefined, true, false, false],
    ["read-only", ["system.info", "desktop.observe"], ["operator.read"], true, true, false],
    [
      "session-only",
      ["system.info", "desktop.observe"],
      ["operator.sessions.read", "operator.sessions.write"],
      false,
      false,
      false,
    ],
  ])(
    "loads only available host details for %s connections",
    async (_name, methods, scopes, read, systemInfo, desktop) => {
      const { client, request } = clientFor();
      const snapshot = gatewaySnapshot(client, true, methods, scopes);
      if (methods === undefined && snapshot.hello) {
        delete snapshot.hello.features;
      }
      const page = mountPage(gatewayFixture(snapshot), {
        devicesList: { paired: [], pending: [] },
      });
      await vi.waitFor(() => expect(pageText(page)?.includes("Gateway host")).toBe(read));
      await settle();
      for (const methodName of ["system-presence", "node.list"]) {
        expect(methodsCalled(request).includes(methodName)).toBe(read);
      }
      expect(methodsCalled(request).includes("system.info")).toBe(systemInfo);
      expect(methodsCalled(request).includes("environments.list")).toBe(desktop);
      await vi.waitFor(() => {
        expect(query(page, ".device-entry__desktop") !== null).toBe(desktop);
        expect(query(page, ".device-resource--load") !== null).toBe(systemInfo);
      });
    },
  );

  it("refreshes host details with quiet inventory polling and stops after disposal", async () => {
    vi.useFakeTimers();
    const page = mountConnected(
      undefined,
      {},
      ["system.info", "desktop.observe"],
      ["operator.admin"],
    );
    const { request, fixture } = page;
    await vi.advanceTimersByTimeAsync(0);
    flush();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    flush();
    expect(callsTo(request, "system.info")).toHaveLength(2);
    expect(callsTo(request, "environments.list")).toHaveLength(2);
    page.dispose();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.emitEvent("node.hostStats", {});
    expect(request).not.toHaveBeenCalled();
    expect(fixture.subscriptions).toBe(0);
  });

  it("stops denied system-info refreshes until the connection resets", async () => {
    vi.useFakeTimers();
    const { client, request } = clientFor(
      vi.fn(async (method: string) => {
        if (method === "system.info") {
          throw missingReadScopeErrorFixture();
        }
        return responseFor(method);
      }),
    );
    const snapshot = gatewaySnapshot(client, true, ["system.info"]);
    const fixture = gatewayFixture(snapshot);
    mountPage(fixture);
    await vi.advanceTimersByTimeAsync(120_000);
    flush();
    expect(callsTo(request, "system.info")).toHaveLength(1);
    fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
    fixture.emitSnapshot(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(callsTo(request, "system.info")).toHaveLength(2);
  });

  it.each(["reconnect", "provider replacement", "dispose"])(
    "retires host-detail responses after %s",
    async (transition) => {
      const systemInfo = createDeferred<SystemInfoResult>();
      const environments = createDeferred<{ environments: EnvironmentSummary[] }>();
      const { client, request } = clientFor(
        vi.fn(async (method: string) => {
          if (method === "system.info") {
            return systemInfo.promise;
          }
          if (method === "environments.list") {
            return environments.promise;
          }
          return responseFor(method);
        }),
      );
      const snapshot = gatewaySnapshot(
        client,
        true,
        ["system.info", "desktop.observe"],
        ["operator.admin"],
      );
      const fixture = gatewayFixture(snapshot);
      const page = mountPage(fixture);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("environments.list", {}, expect.anything()),
      );
      if (transition === "dispose") {
        page.dispose();
      } else {
        request.mockImplementation(async (method: string) =>
          method === "environments.list"
            ? { environments: [] }
            : method === "system.info"
              ? { ...deviceSystemInfo, loadAverage: [8, 4, 2] }
              : responseFor(method),
        );
        if (transition === "reconnect") {
          fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
          fixture.emitSnapshot(snapshot);
        } else {
          page.replaceGateway(gatewayFixture(snapshot));
        }
        await vi.waitFor(() =>
          expect(query(page, ".device-resource--load")?.textContent).toContain("8.0"),
        );
      }
      systemInfo.resolve(deviceSystemInfo);
      environments.resolve({ environments: deviceDesktopEnvironments });
      await Promise.all([systemInfo.promise, environments.promise]);
      await vi.waitFor(() => {
        expect(query(page, ".device-entry__desktop")).toBeNull();
        if (transition !== "dispose") {
          expect(query(page, ".device-resource--load")?.textContent).toContain("8.0");
        }
      });
    },
  );

  it.each(["device", "node"])(
    "coalesces a %s refresh while an older list is loading",
    async (kind) => {
      const stale = createDeferred<unknown>();
      const refreshed = createDeferred<unknown>();
      const methodName = kind === "device" ? "device.pair.list" : "node.list";
      let listCalls = 0;
      const { client, request } = replying(methodName, () =>
        ++listCalls === 1 ? stale.promise : refreshed.promise,
      );
      const fixture = gatewayFixture(gatewaySnapshot(client));
      const page = mountPage(fixture);
      await vi.waitFor(() => expect(listCalls).toBe(1));
      await waitForSolid(() => expect(query(page, ".settings-loading-skeleton")).not.toBeNull());
      fixture.emitEvent(kind === "device" ? "device.pair.changed" : "node.hostStats", {});
      stale.resolve(
        kind === "device"
          ? { paired: [{ deviceId: "device-1", displayName: "Kitchen Mac" }], pending: [] }
          : { nodes: [{ nodeId: "node-1", displayName: "Kitchen Mac" }] },
      );
      await vi.waitFor(() => expect(listCalls).toBe(2));
      expect(query(page, ".settings-loading-skeleton")).not.toBeNull();
      refreshed.resolve(
        kind === "device"
          ? {
              paired: [
                { deviceId: "device-1", displayName: "Kitchen Mac", operatorLabel: "Studio Mac" },
              ],
              pending: [],
            }
          : { nodes: [{ nodeId: "node-1", displayName: "Studio Mac" }] },
      );
      await vi.waitFor(() => expect(pageText(page)).toContain("Studio Mac"));
      expect(query(page, ".settings-loading-skeleton")).toBeNull();
      expect(callsTo(request, methodName)).toHaveLength(2);
    },
  );

  it("shows a skeleton for an event refresh of an already-loaded empty inventory", async () => {
    const completion = createDeferred<unknown>();
    let holdPairing = false;
    const { client } = replying("device.pair.list", () =>
      holdPairing ? completion.promise : responseFor("device.pair.list"),
    );
    const fixture = gatewayFixture(gatewaySnapshot(client));
    const page = mountPage(fixture, { devicesList: { paired: [], pending: [] } });
    await waitForSolid(() => expect(query(page, ".settings-loading-skeleton")).toBeNull());
    holdPairing = true;
    fixture.emitEvent("device.pair.requested", {});
    await waitForSolid(() =>
      expect(page.container.querySelectorAll(".settings-loading-skeleton")).toHaveLength(1),
    );
    completion.resolve({ paired: [], pending: [] });
    await waitForSolid(() => expect(query(page, ".settings-loading-skeleton")).toBeNull());
  });

  it("keeps initial and event-driven pairing and exec-approval loads gated by scopes", async () => {
    const { client, request } = clientFor();
    const fixture = gatewayFixture(
      gatewaySnapshot(
        client,
        true,
        ["node.list", "device.pair.list", "exec.approvals.get"],
        ["operator.read"],
      ),
    );
    const page = mountPage(fixture);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    fixture.emitEvent("presence", {
      presence: [{ instanceId: "browser-1", ts: 2_000, reason: "connect" }],
    });
    fixture.emitEvent("device.pair.changed", {});
    await settle();
    expect(methodsCalled(request)).not.toContain("device.pair.list");
    expect(methodsCalled(request)).not.toContain("exec.approvals.get");
    expect(button(page.container, t("devices.pairing.button")).disabled).toBe(true);
  });

  it.each([
    { name: "node disconnects", role: "node", nodeRoles: ["node"], operatorRoles: ["operator"] },
    {
      name: "merged node-role presence disconnects",
      role: "node",
      nodeRoles: ["operator", "node"],
      operatorRoles: ["operator"],
    },
    {
      name: "operator disconnects",
      role: "operator",
      nodeRoles: ["node"],
      operatorRoles: ["operator"],
    },
    {
      name: "node disconnects with a roleless operator",
      role: "node",
      nodeRoles: ["node"],
      operatorRoles: undefined,
    },
  ])("reloads mixed-role inventory when $name", async (scenario) => {
    const { request, fixture } = mountConnected(undefined, {
      nodes: [{ nodeId: "node-1" }],
      devicesList: { paired: [], pending: [] },
    });
    const node: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: "node",
      roles: scenario.nodeRoles,
      reason: "connect",
      ts: 2_000,
    };
    const operator: PresenceEntry = {
      deviceId: "mixed-role-device",
      instanceId: "operator-session",
      roles: scenario.operatorRoles,
      reason: "connect",
      ts: 1_000,
    };
    fixture.emitEvent("presence", { presence: [node, operator] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("device.pair.list", {}));
    await settle();
    request.mockClear();
    fixture.emitEvent("presence", {
      presence: [
        scenario.role === "node" ? { ...node, reason: "disconnect" } : node,
        scenario.role === "operator" ? { ...operator, reason: "disconnect" } : operator,
      ],
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("node.list", {}));
    expect(request).toHaveBeenCalledWith("device.pair.list", {});
  });

  it("does not reload mixed-role inventory for presence activity updates", async () => {
    const { request, fixture } = mountConnected(undefined, {
      nodes: [{ nodeId: "node-1" }],
      devicesList: { paired: [], pending: [] },
    });
    const presence: PresenceEntry[] = [
      { deviceId: "mixed-role-device", roles: ["node"], reason: "connect", ts: 2_000 },
      { deviceId: "mixed-role-device", roles: ["operator"], reason: "connect", ts: 1_000 },
    ];
    fixture.emitEvent("presence", { presence });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("device.pair.list", {}));
    await settle();
    request.mockClear();
    fixture.emitEvent("presence", {
      presence: presence.map((entry) =>
        Object.assign({}, entry, { lastInputSeconds: 3, ts: entry.ts + 100 }),
      ),
    });
    await settle();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["reconnect", "provider replacement", "remount"])(
    "retires an in-flight node load across %s",
    async (transition) => {
      const first = createDeferred<unknown>();
      const second = createDeferred<unknown>();
      let listCalls = 0;
      const { client } = replying("node.list", () =>
        ++listCalls === 1 ? first.promise : second.promise,
      );
      const snapshot = gatewaySnapshot(client);
      const fixture = gatewayFixture(snapshot);
      let page = mountPage(fixture);
      await vi.waitFor(() => expect(listCalls).toBe(1));
      if (transition === "reconnect") {
        fixture.emitSnapshot({ ...snapshot, phase: "reconnecting" });
        fixture.emitSnapshot(snapshot);
      } else if (transition === "provider replacement") {
        page.replaceGateway(gatewayFixture(snapshot));
      } else {
        page.dispose();
        page = mountPage(fixture);
      }
      await vi.waitFor(() => expect(listCalls).toBe(2));
      second.resolve({ nodes: [{ nodeId: "new", displayName: "New Mac" }] });
      await vi.waitFor(() => expect(pageText(page)).toContain("New Mac"));
      first.resolve({ nodes: [{ nodeId: "old", displayName: "Old Mac" }] });
      await first.promise;
      await settle();
      expect(pageText(page)).not.toContain("Old Mac");
      expect(pageText(page)).toContain("New Mac");
    },
  );

  it.each(["removal", "alias"])(
    "retains a pending %s dialog through reconnect and cancels it on fresh pairing denial",
    async (kind) => {
      const request = vi.fn(async (method: string) =>
        method === "node.list"
          ? { nodes: [{ nodeId: "node-1", displayName: "Office Mac" }] }
          : responseFor(method),
      );
      const page = mountPaired(request);
      await selectEntryAction(page.container, kind === "alias" ? "editAlias" : "remove");
      await waitForRenderedModalDialog(document.body);
      if (kind === "alias") {
        const input = document.body.querySelector<HTMLInputElement>('input[name="value"]')!;
        input.value = "Draft device alias";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flush();
      }
      const label = kind === "alias" ? t("common.save") : t("devices.inventory.remove");
      expect(dialogButton(label).disabled).toBe(false);
      request.mockClear();
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      expect(modalQuery("openclaw-modal-dialog")).not.toBeNull();
      await waitForSolid(() => expect(dialogButton(label).disabled).toBe(true));
      expect(request).not.toHaveBeenCalled();
      page.fixture.emitSnapshot(gatewaySnapshot(page.client));
      await waitForSolid(() => expect(dialogButton(label).disabled).toBe(false));
      if (kind === "alias") {
        expect(document.body.querySelector<HTMLInputElement>('input[name="value"]')?.value).toBe(
          "Draft device alias",
        );
      }
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, true, [], ["operator.read"]));
      await expectNoModal();
      expect(pageText(page)).not.toContain("MacBook Pro");
      expect(pageText(page)).toContain("Office Mac");
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, true, [], []));
      await waitForSolid(() => expect(query(page, ".device-entry")).toBeNull());
      expect(methodsCalled(request)).not.toContain("device.pair.remove");
      expect(methodsCalled(request)).not.toContain("device.pair.rename");
    },
  );

  it("rejects a device pairing request after the in-app dialog is confirmed", async () => {
    const page = mountConnected(undefined, {
      nodes: [{ nodeId: "node-1" }],
      devicesList: {
        paired: [],
        pending: [{ requestId: "request-1", deviceId: "device-1", displayName: "Browser" }],
      },
    });
    const { request } = page;
    button(page.container, t("devices.inventory.reject")).click();
    const { dialog } = await waitForRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe(t("devices.inventory.rejectDevicePromptTitle"));
    dialogButton(t("devices.inventory.reject")).click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("device.pair.reject", { requestId: "request-1" }),
    );
    await expectNoModal();
  });

  it("issues no node pairing request when the dialog is cancelled", async () => {
    const page = mountConnected(undefined, {
      nodes: [
        {
          nodeId: "node-1",
          displayName: "Pending node",
          approvalState: "pending-approval",
          pendingRequestId: "request-2",
        },
      ],
      devicesList: { paired: [], pending: [] },
    });
    const { request } = page;
    await selectEntryAction(page.container, "reject", "Pending node");
    await waitForRenderedModalDialog(document.body);
    request.mockClear();
    dialogButton(t("common.cancel")).click();
    await expectNoModal();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["connection resets", "pairing access is lost"])(
    "drops a token revoke after %s during confirmation",
    async (transition) => {
      const request = vi.fn(async (method: string) => responseFor(method));
      const page = mountPaired(request);
      button(page.container, t("devices.inventory.revoke")).click();
      const { dialog } = await waitForRenderedModalDialog(document.body);
      expect(dialog.getAttribute("aria-label")).toBe(
        t("devices.inventory.revokePromptTitle", { role: "operator" }),
      );
      request.mockClear();
      if (transition === "connection resets") {
        page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      } else {
        page.fixture.emitSnapshot(
          gatewaySnapshot(page.client, true, ["device.token.revoke"], ["operator.read"]),
        );
      }
      if (transition === "connection resets") {
        await waitForSolid(() =>
          expect(dialogButton(t("devices.inventory.revoke")).disabled).toBe(true),
        );
        dialogButton(t("devices.inventory.revoke")).click();
        expect(modalQuery("openclaw-modal-dialog")).not.toBeNull();
        dialogButton(t("common.cancel")).click();
      }
      await expectNoModal();
      expect(methodsCalled(request)).not.toContain("device.token.revoke");
    },
  );

  it("keeps the rotated token and copy control visible until explicit acknowledgement", async () => {
    const { dialog, modal } = await openRotation(ROTATED_TOKEN);
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotatePromptTitle", { role: "operator" }),
    );
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(modalQuery(".chat-copy-btn")).toBeInstanceOf(HTMLButtonElement);
    const dismissal = dismissalEvent();
    modal.dispatchEvent(dismissal);
    await modal.updateComplete;
    expect(dismissal.defaultPrevented).toBe(true);
    expect(secretDialogText()).toBe(ROTATED_TOKEN);
    expect(document.body.textContent).toContain(t("devices.inventory.rotateDismissHint"));
    dialogButton(t("devices.inventory.rotateAcknowledge")).click();
    await expectNoModal();
  });

  it("reveals a rotated token that lands after a connection reset", async () => {
    stubLocalDeviceIdentity();
    const rotated = createDeferred<unknown>();
    const request = dialogs.mockRequest(async (method: string) =>
      method === "device.token.rotate" ? rotated.promise : responseFor(method),
    );
    const page = mountPaired(request);
    const outcome = {
      deviceId: "device-1",
      role: "operator",
      scopes: [],
      rotatedAtMs: 1_700_000_000_000,
      token: ROTATED_TOKEN,
      tokenDelivery: "in-band",
    };
    try {
      button(page.container, t("devices.inventory.rotate")).click();
      await vi.waitFor(() => expect(methodsCalled(request)).toContain("device.token.rotate"));
      page.fixture.emitSnapshot(gatewaySnapshot(page.client, false));
      rotated.resolve(outcome);
      await waitForRenderedModalDialog(document.body);
      expect(secretDialogText()).toBe(ROTATED_TOKEN);
      dialogButton(t("devices.inventory.rotateAcknowledge")).click();
      await expectNoModal();
    } finally {
      rotated.resolve(outcome);
    }
  });

  it("explains a cross-device rotation the Gateway withheld the token for", async () => {
    const { dialog } = await openRotation(null);
    expect(dialog.getAttribute("aria-label")).toBe(
      t("devices.inventory.rotateWithheldTitle", { device: "MacBook Pro" }),
    );
    expect(document.body.textContent).toContain(t("devices.inventory.rotateWithheldNext"));
    expect(modalQuery(".secret-reveal__callout")?.textContent).toContain(
      t("devices.inventory.rotateWithheldException"),
    );
    expect(modalQuery(".secret-reveal__status")).not.toBeNull();
    expect(modalQuery(".secret-reveal__note")?.textContent).toContain(
      t("devices.inventory.rotateWithheldNote"),
    );
    expect(modalQuery(".secret-reveal__code")).toBeNull();
    expect(modalQuery(".chat-copy-btn")).toBeNull();
    expect(dialogButton(t("common.close")).className).toBe("btn secret-reveal__dismiss");
    dialogButton(t("common.close")).click();
    await expectNoModal();
  });

  it("lets a dismissal gesture close the withheld-rotation outcome", async () => {
    const { modal } = await openRotation(null);
    const dismissal = dismissalEvent();
    modal.dispatchEvent(dismissal);
    await expectNoModal();
    expect(dismissal.defaultPrevented).toBe(false);
  });

  it("shows a visible error without a reveal when the rotate request fails", async () => {
    stubLocalDeviceIdentity();
    const request = vi.fn(async (method: string) => {
      if (method === "device.token.rotate") {
        throw new Error("rotate refused");
      }
      return responseFor(method);
    });
    const page = mountPaired(request);
    button(page.container, t("devices.inventory.rotate")).click();
    await vi.waitFor(() => expect(pageText(page)).toContain("rotate refused"));
    expect(modalQuery("openclaw-modal-dialog")).toBeNull();
  });
});
