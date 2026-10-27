/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads optional English at its consumers while preserving the active locale and namespaces", async () => {
  const { en, manager } = await loadI18n({
    common: { health: "Gesundheit" },
    sessionsView: { goal: "Ziel" },
    chat: { sessionDetails: { context: "Kontext" } },
  });
  const { sessionsView, aboutPage: about, dashboardsPage: dashboards } = en;
  const modelAccounts = en.profilePage.modelAccounts;
  const details = en.chat.sessionDetails;
  expect(manager.t("aboutPage.artifactDetails")).toBe("Control UI build details");
  await manager.setLocale("de");
  await Promise.all([
    import("../components/app-sidebar-catalog-menu.tsx"),
    import("../components/personal-session-groups.tsx"),
    import("../components/session-menu-access.ts"),
    import("../lib/chat/complete-history.ts"),
    import("../lib/sessions/session-archive-reason.ts"),
    import("../lib/sessions/session-menu-navigation.ts"),
    import("../pages/chat/components/chat-model-account-control.ts"),
    import("../pages/chat/chat-pane-native-session-actions.ts"),
    import("../pages/chat/chat-pane-placement.ts"),
  ]);
  expect(manager.t("sessionsView.searchGroups")).toBe("sessionsView.searchGroups");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("Edit personal group");
  expect(manager.t("sessionsView.personalGroupHint")).toBe(
    "Only your layout changes. Sessions and shared groups stay unchanged.",
  );
  expect(manager.t("sessionsView.active")).toBe("Updated within");
  expect(manager.t("sessionsView.all")).toBe("All");
  expect(manager.t("sessionsView.snoozed")).toBe("Snoozed");
  expect(manager.t("sessionsView.archiveReasonManual")).toBe("Archived manually");
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Build" })).toBe(
    'Stop the cloud worker for "Build"?',
  );
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(manager.t("profilePage.modelAccounts.loadMore")).toBe("Load more saved accounts");
  expect(manager.t("profilePage.modelAccounts.inventoryFailed")).toBe(
    "Could not load saved accounts. Refresh to retry.",
  );
  expect(en.profilePage.modelAccounts).toBe(modelAccounts);
  (await import("./locales/en-session-organization.ts")).registerSessionOrganizationEnglish();
  expect(manager.t("sessionsView.searchGroups")).toBe("Search groups");
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(en.sessionsView).toBe(sessionsView);
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatSessionEnglish);
  expect(manager.t("chat.sessionDetails.title")).toBe("Details");
  expect(manager.t("chat.sessionDetails.environment")).toBe("chat.sessionDetails.environment");
  await import("../pages/chat/components/chat-context-breakdown.tsx");
  expect(manager.t("chat.sessionDetails.environment")).toBe("Environment");
  expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
  expect(en.chat.sessionDetails).toBe(details);
  for (const [key, copy, load] of [
    ["aboutPage.linkDocs", "Docs", () => import("../pages/about/view.tsx")],
    ["dashboardsPage.live", "Live", () => import("../pages/dashboards/view.tsx")],
    [
      "profilePage.modelAccounts.connectAction",
      "Sign in",
      () => import("../pages/profile/model-accounts.tsx"),
    ],
  ] as const) {
    expect(manager.t(key)).toBe(key);
    await load();
    expect(manager.t(key)).toBe(copy);
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(en.aboutPage).toBe(about);
    expect(en.dashboardsPage).toBe(dashboards);
  }
  expect(manager.getLocale()).toBe("de");
});

it("keeps a cold roster metadata failure readable before its view catalog loads", async () => {
  const { en, manager } = await loadI18n();
  const agentsHome = en.agentsHome;
  const { createRosterFixture, rosterResult } =
    await import("../lib/agents/roster-activity-store.test-support.ts");
  const { createTestGatewayClient } = await import("../test-helpers/gateway-client.ts");
  const replies = new Map<string, () => unknown>([
    ["sessions.subscribe", () => ({ subscribed: true })],
    ["sessions.groups.list", () => ({ groups: [], sectionOrder: [] })],
    ["sessions.list", rosterResult],
  ]);
  const client = createTestGatewayClient(async (method) => {
    const reply = replies.get(method);
    if (!reply) {
      throw new Error(`Unexpected RPC: ${method}`);
    }
    return reply();
  });
  const { context, store, sessions } = createRosterFixture(client);
  context.agents.ensureList = async () => null;
  expect(manager.t("agentsHome.pinnedAgents")).toBe("agentsHome.pinnedAgents");
  const stop = store.subscribe(() => {});
  try {
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerAgentsHomeEnglish } = await import("./locales/en-agents-home.ts");
    registerEnglishCatalog(registerAgentsHomeEnglish);
    expect(en.agentsHome).toBe(agentsHome);
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
  } finally {
    stop();
    sessions.dispose();
  }
});
