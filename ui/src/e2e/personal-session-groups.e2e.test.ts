import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:reliability";
const releaseKey = "agent:main:release";

suite.define(() => {
  it.for(["operator.admin", "operator.sessions.read"])(
    "organizes a personal layout without shared mutations (%s)",
    async (scope) => {
      const capture =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && scope === "operator.sessions.read";
      const artifacts = capture
        ? createControlUiE2eArtifactDir(
            "personal-session-groups",
            process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
          )
        : undefined;
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          ...(artifacts
            ? { recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } } }
            : {}),
        },
        async ({ page }) => {
          const childKey = "agent:main:reliability-child";
          const rows = [
            createControlUiSessionRow(key, "Reliability Tracker", Date.now(), {
              category: "Engineering",
              childSessions: [childKey],
            }),
            createControlUiSessionRow(releaseKey, "Release checklist", Date.now() - 1000),
            createControlUiSessionRow(childKey, "Verification notes", Date.now() - 2000, {
              spawnedBy: key,
            }),
          ];
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            operatorScopes: [scope],
            sessions: rows,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`).waitFor();
          expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
          if (artifacts) {
            await captureFrame(artifacts, "after-unused.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
          }
          const openCollections = async (sessionKey: string) => {
            await sidebar
              .locator('.sidebar-recent-session[data-session-key="' + sessionKey + '"]')
              .first()
              .click({ button: "right" });
            const panel = page.locator(".session-menu__panel").first();
            await panel.waitFor({ state: "visible" });
            // Shared organization stays present with its original guest disabled policy.
            const move = page.getByRole("menuitem", { name: "Move to group", exact: true });
            expect(await move.isDisabled()).toBe(scope === "operator.sessions.read");
            await page
              .getByRole("menuitem", { name: "Add to my collections", exact: true })
              .hover();
            await page.getByRole("menuitem", { name: "New collection", exact: true }).waitFor();
          };
          // First collection is discoverable from the native session menu, without a section.
          await openCollections(key);
          if (artifacts) {
            await captureFrame(artifacts, "native-discovery.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
          }
          await page.getByRole("menuitem", { name: "New collection", exact: true }).click();
          const firstDialog = page.getByRole("dialog", { name: "New collection", exact: true });
          expect(
            await firstDialog
              .getByRole("checkbox", { name: "Reliability Tracker", exact: true })
              .isChecked(),
          ).toBe(true);
          await firstDialog.getByLabel("Collection name", { exact: true }).fill("Focus");
          if (artifacts) {
            await captureFrame(artifacts, "creation.png", page.locator(".shell"), [firstDialog]);
          }
          await firstDialog.getByRole("button", { name: "Save", exact: true }).click();
          await firstDialog.waitFor({ state: "hidden" });
          const create = async (label: string, selected?: string) => {
            await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
            await page
              .locator(".sidebar-session-sort-menu")
              .getByRole("button", { name: "New collection", exact: true })
              .click();
            const dialog = page.getByRole("dialog", { name: "New collection", exact: true });
            await dialog.getByLabel("Collection name", { exact: true }).fill(label);
            if (selected) {
              await dialog.getByRole("checkbox", { name: selected, exact: true }).check();
            }
            await dialog.getByRole("button", { name: "Save", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
          };
          const group = (label: string) =>
            sidebar
              .locator("[data-personal-session-group]")
              .filter({ has: page.getByRole("list", { name: label, exact: true }) });
          const options = async (label: string, action: string) => {
            await sidebar
              .getByRole("button", { name: `Options for collection ${label}`, exact: true })
              .click();
            await page.getByRole("menuitem", { name: action, exact: true }).click();
          };
          const childToggle = sidebar
            .locator('[data-session-section="category:Engineering"]')
            .locator(`[data-child-session-toggle="${key}"]`);
          await childToggle.waitFor();
          if ((await childToggle.getAttribute("aria-expanded")) === "false") {
            await childToggle.click();
          }
          await sidebar.locator(`[data-session-key="${childKey}"]`).first().waitFor();

          await group("Focus")
            .getByRole("link", { name: /Reliability Tracker/ })
            .waitFor();
          if (artifacts) {
            await captureFrame(artifacts, "grouped-children.png", page.locator(".shell"), [
              group("Focus"),
              sidebar.locator('[data-session-section="category:Engineering"]'),
            ]);
            console.log("Personal group child-tree proof: " + artifacts);
          }
          await group("Focus")
            .getByRole("link", { name: /Verification notes/ })
            .waitFor();
          expect(await sidebar.locator(`[data-session-key="${childKey}"]`).count()).toBe(2);
          await create("Later");
          expect(
            await group("Later")
              .getByText("Drag sessions here or choose Edit collection to add them.")
              .isVisible(),
          ).toBe(true);
          // Adding an existing reference is not a shared move, including for read-only guests.
          await openCollections(releaseKey);
          await page.getByRole("menuitem", { name: "Focus", exact: true }).click();
          await group("Focus")
            .getByRole("link", { name: /Release checklist/ })
            .waitFor();
          await options("Focus", "Edit collection");
          const editor = page.getByRole("dialog", { name: "Edit collection", exact: true });
          await editor.getByLabel("Collection name", { exact: true }).fill("This week");
          await editor
            .getByRole("checkbox", { name: "Reliability Tracker", exact: true })
            .uncheck();
          await editor.getByRole("button", { name: "Save", exact: true }).click();
          await editor.waitFor({ state: "hidden" });
          expect(await group("This week").locator(".sidebar-recent-session").count()).toBe(1);
          await options("Later", "Move up");
          const order = () =>
            sidebar
              .locator("[data-personal-session-group] .sidebar-session-group-toggle")
              .allTextContents();
          await expect.poll(order).toEqual(["Later", "This week"]);
          // Native group dragging is also personal, with a keyboard menu equivalent above.
          await group("Later")
            .locator(".personal-session-groups__header")
            .dragTo(group("This week"));
          await expect.poll(order).toEqual(["This week", "Later"]);
          await page.reload();
          await expect.poll(order).toEqual(["This week", "Later"]);
          await group("This week")
            .getByRole("link", { name: /Release checklist/ })
            .waitFor();
          if (artifacts && process.env.OPENCLAW_PERSONAL_GROUP_PROOF_STAGE !== "before") {
            await sidebar.getByRole("button", { name: "New collection", exact: true }).hover();
            await captureFrame(artifacts, "after.png", page.locator(".shell"), [
              sidebar.locator(".sidebar-sessions"),
            ]);
            console.log("Personal groups after proof: " + artifacts);
          }
          await options("This week", "Remove collection");
          await expect.poll(order).toEqual(["Later"]);
          expect(
            await sidebar
              .locator(`.sidebar-recent-session[data-session-key="${releaseKey}"]`)
              .count(),
          ).toBe(1);
          expect(
            await sidebar.locator('[data-session-section="category:Engineering"]').count(),
          ).toBe(1);
          await options("Later", "Remove collection");
          expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
          await create("Empty by choice");
          expect(await group("Empty by choice").count()).toBe(1);
          console.log("Collection UI proof: " + artifacts);
          for (const method of [
            "sessions.patch",
            "sessions.delete",
            "sessions.deleteMany",
            "sessions.groups.put",
            "sessions.groups.rename",
            "sessions.groups.delete",
            "config.patch",
          ]) {
            expect(await gateway.getRequests(method)).toEqual([]);
          }
        },
        async ({ page, context }) => {
          const video = page.video();
          await suite.closeBrowserContext(context);
          if (artifacts) {
            await video?.saveAs(path.join(artifacts, "personal-groups.webm"));
          }
        },
      );
    },
  );

  it("discovers collections without a selected session and keeps native compact Back", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: [
          createControlUiSessionRow(key, "Reliability Tracker", Date.now(), {
            category: "Engineering",
          }),
        ],
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
      await waitForMobileSidebarDrawerOpen(page);
      const sidebar = page.locator("openclaw-app-sidebar:visible");
      expect(await sidebar.locator(".personal-session-groups").count()).toBe(0);
      await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("button", { name: "New collection", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New collection", exact: true });
      await dialog.getByLabel("Collection name", { exact: true }).fill("Reading");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await sidebar.getByRole("link", { name: /Reliability Tracker/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to my collections", exact: true }).click();
      await page.getByRole("menuitem", { name: "Back", exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir("personal-collections-narrow");
        await captureFrame(artifacts, "narrow-menu.png", page.locator(".shell"), []);
      }
      await page.getByRole("menuitem", { name: "Back", exact: true }).click();
      expect(
        await page.getByRole("menuitem", { name: "Move to group", exact: true }).isDisabled(),
      ).toBe(true);
      await page.getByRole("menuitem", { name: "Add to my collections", exact: true }).click();
      await page.getByRole("menuitem", { name: "Reading", exact: true }).click();
      await sidebar
        .locator("[data-personal-session-group]")
        .getByRole("link", { name: /Reliability Tracker/ })
        .waitFor();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });

  it("selects descriptor-only groups in visible order and batches each expanded member once", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const selected = createControlUiSessionRow(key, "Reliability Tracker", Date.now());
      const members = ["first", "middle", "last"].map((id) =>
        createControlUiSessionRow("agent:main:" + id, id + " project", Date.now()),
      );
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.admin"],
        sessions: [selected, ...members],
        methodResponses: { "sessions.list": sessionsListResponse([selected]) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          sidebarEntries: ["session:agent:main:first"],
          personalSessionGroups: [
            { id: "first", label: "First", sessionKeys: ["agent:main:first"] },
            { id: "middle", label: "Middle", sessionKeys: ["agent:main:middle"] },
            { id: "last", label: "Last", sessionKeys: ["agent:main:last", "agent:main:first"] },
          ],
        }),
      );
      const group = (id: string) => page.locator('[data-personal-session-group="' + id + '"]');
      const row = (id: string) =>
        group(id).getByRole("link", { name: id + " project", exact: true });
      for (const id of ["first", "middle", "last"]) {
        await row(id).waitFor();
      }
      await row("first").click({ modifiers: ["Alt"] });
      await row("last").click({ modifiers: ["Alt"] });
      await row("last").click({ button: "right" });
      const menu = page.locator("openclaw-session-menu");
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 2", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");

      // Ordinary navigation clears selection; Shift includes the intervening group.
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 3", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");

      // A duplicate's clicked appearance, not its first occurrence, bounds the range.
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("last").click({ modifiers: ["Alt"] });
      await group("last")
        .getByRole("link", { name: "first project", exact: true })
        .click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Archive 2", exact: true }).count())
        .toBe(1);
      await page.keyboard.press("Escape");
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });

      // Normal navigation must retain the clicked occurrence as the next Shift anchor.
      await group("last").getByRole("link", { name: "first project", exact: true }).click();
      await expect
        .poll(() =>
          group("last")
            .getByRole("link", { name: "first project", exact: true })
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await expect
        .poll(() =>
          menu
            .getByRole("menuitem", { name: /^Archive [0-9]+$/, exact: true })
            .getAttribute("aria-label"),
        )
        .toBe("Archive 2");
      await page.keyboard.press("Escape");
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ })
        .click();
      await row("first").click({ modifiers: ["Alt"] });

      // A canonical pin must not inherit the first active personal-group appearance.
      const canonicalPin = page
        .locator('[data-session-section="pinned"]')
        .getByRole("link", { name: "first project", exact: true });
      const ordinary = page
        .locator("openclaw-app-sidebar")
        .getByRole("link", { name: /Reliability Tracker/ });
      await canonicalPin.click();
      await expect.poll(() => canonicalPin.getAttribute("aria-current")).toBe("page");
      await ordinary.click({ modifiers: ["Shift"] });
      await ordinary.click({ button: "right" });
      await expect
        .poll(() =>
          menu
            .getByRole("menuitem", { name: /^Archive [0-9]+$/, exact: true })
            .getAttribute("aria-label"),
        )
        .toBe("Archive 2");
      await page.keyboard.press("Escape");
      await ordinary.click();
      await row("first").click({ modifiers: ["Alt"] });

      // A collapsed group is not a batch target, and duplicate placements never duplicate writes.
      await group("middle").getByRole("button", { name: "Middle", exact: true }).click();
      await row("middle").waitFor({ state: "hidden" });
      await row("last").click({ modifiers: ["Shift"] });
      await row("last").click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Archive 2", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.patchMany");
      expect(request.params).toMatchObject({
        patch: { archived: true },
        targets: [members[0], members[2]].map((member) => ({
          key: member!.key,
          agentId: "main",
          expectedSessionId: member!.sessionId,
        })),
      });
    });
  });

  it("rejects an open editor that would overwrite newer group membership", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const rows = [
        createControlUiSessionRow(key, "Reliability Tracker", Date.now()),
        createControlUiSessionRow(releaseKey, "Release checklist", Date.now()),
      ];
      await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: rows,
        methodResponses: { "sessions.list": sessionsListResponse(rows) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            { id: "shared-tab", label: "Focus", sessionKeys: ["agent:main:reliability"] },
          ],
        }),
      );
      await page.getByRole("button", { name: "Options for collection Focus", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit collection", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit collection", exact: true });
      await dialog.getByLabel("Collection name", { exact: true }).fill("Renamed");
      // The preference owner receives a newer saved layout while this editor is open.
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            { id: "shared-tab", label: "Focus", sessionKeys: ["agent:main:release"] },
          ],
        }),
      );
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog
        .getByRole("alert")
        .getByText("This collection changed. Reopen it before saving your edits.", { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      const group = page.locator('[data-personal-session-group="shared-tab"]');
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.getByRole("link", { name: /Reliability Tracker/ }).count()).toBe(0);
      await page.getByRole("button", { name: "Options for collection Focus", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit collection", exact: true }).click();
      expect(
        await dialog.getByRole("checkbox", { name: "Release checklist", exact: true }).isChecked(),
      ).toBe(true);
      await dialog.getByLabel("Collection name", { exact: true }).fill("Renamed");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await group.getByRole("list", { name: "Renamed", exact: true }).waitFor();
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
    });
  });

  it("keeps a long membership list scrollable with visible completion actions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 600 } }, async ({ page }) => {
      const rows = Array.from({ length: 60 }, (_, index) =>
        createControlUiSessionRow(
          index === 0 ? key : `agent:main:project-${index}`,
          index === 0 ? "Reliability Tracker" : `Project ${index} ${"long-name-".repeat(20)}`,
          Date.now() - index,
        ),
      );
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: rows,
        methodResponses: { "sessions.list": sessionsListResponse(rows) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("button", { name: /^Filter & sort/ })
        .click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("button", { name: "New collection", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New collection", exact: true });
      await dialog.getByLabel("Collection name", { exact: true }).fill("Long list");
      const choices = dialog.getByRole("group", { name: "Sessions", exact: true });
      await expect
        .poll(() => choices.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await expect
        .poll(() =>
          dialog.evaluate((element) =>
            [element.querySelector("input"), element.querySelector('button[type="submit"]')].every(
              (control) => {
                const rect = control!.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= innerHeight;
              },
            ),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => choices.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir(
          "personal-group-long-list",
          process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
        );
        await captureFrame(artifacts, "long-list.png", page.locator(".shell"), [dialog]);
        console.log("Personal group long-list proof: " + artifacts);
      }
      await choices.getByRole("checkbox").last().check();
      await save.click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("list", { name: "Long list", exact: true }).getByRole("link").waitFor();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });

  it("resolves off-page members without revealing unavailable saved references", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const selected = createControlUiSessionRow(key, "Reliability Tracker", Date.now());
      const offPage = createControlUiSessionRow(releaseKey, "Release checklist", Date.now());
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.read"],
        sessions: [selected, offPage],
        methodResponses: { "sessions.list": sessionsListResponse([selected]) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            {
              id: "saved",
              label: "Saved work",
              sessionKeys: ["agent:main:release", "agent:main:unavailable"],
            },
          ],
        }),
      );
      const group = page.locator('[data-personal-session-group="saved"]');
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await group.textContent()).not.toContain("unavailable");
      await evaluateControlUiContext(page, ({ navigation }) =>
        navigation.update({
          personalSessionGroups: [
            ...(navigation.snapshot.personalSessionGroups ?? []),
            { id: "later", label: "Later", sessionKeys: [] },
          ],
        }),
      );
      const openOffPageCollections = async () => {
        await group.getByRole("link", { name: /Release checklist/ }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Add to my collections", exact: true }).hover();
        await page.getByRole("menuitem", { name: "New collection", exact: true }).waitFor();
      };
      await openOffPageCollections();
      await page.getByRole("menuitem", { name: "Later", exact: true }).click();
      await page
        .locator('[data-personal-session-group="later"]')
        .getByRole("link", { name: /Release checklist/ })
        .waitFor();
      await openOffPageCollections();
      await page.getByRole("menuitem", { name: "New collection", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New collection", exact: true });
      expect(
        await dialog.getByRole("checkbox", { name: "Release checklist", exact: true }).isChecked(),
      ).toBe(true);
      await dialog.getByLabel("Collection name", { exact: true }).fill("Release work");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page
        .getByRole("list", { name: "Release work", exact: true })
        .getByRole("link", { name: /Release checklist/ })
        .waitFor();
      await page.reload();
      await group.getByRole("link", { name: /Release checklist/ }).waitFor();
      expect(await group.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
    });
  });
});
