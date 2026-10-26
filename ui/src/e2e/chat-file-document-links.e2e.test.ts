import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Document file links",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:main";
const section = "Additional human-agent development records";
const files = {
  "guides/faculty-guide.md":
    "# Faculty Guide\n\n[Development records](multiplayer-agentic-workflows.md#additional-human-agent-development-records)\n",
  "guides/multiplayer-agentic-workflows.md":
    "# Multiplayer agentic workflows\n\n[Local records](#additional-human-agent-development-records)\n\n" +
    "Background notes.\n\n".repeat(70) +
    "## " +
    section +
    "\n\nDevelopment records are here.\n\n" +
    "More notes.\n\n".repeat(30),
};
const fileResponse = (filePath: string, content: string) => ({
  root: "/workspace",
  sessionKey,
  file: {
    kind: "read",
    missing: false,
    name: path.basename(filePath),
    path: filePath,
    workspacePath: filePath,
    content,
    contentEncoding: "utf8",
    previewKind: "text",
    mimeType: "text/markdown",
  },
});

suite.define(() => {
  it("opens document-relative heading links without navigating or resolving another session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "demo-model", name: "Demo model", provider: "demo" }],
        agentModel: "demo/demo-model",
        historyMessages: [
          chatMessage("assistant", "[Faculty Guide](guides/faculty-guide.md)", { timestamp: 1 }),
        ],
        methodResponses: {
          "sessions.files.get": {
            cases: [
              ...Object.entries(files).map(([filePath, content]) => ({
                match: { path: "/workspace/" + filePath },
                response: fileResponse(filePath, content),
              })),
              {
                match: { path: "guides/faculty-guide.md" },
                response: fileResponse("guides/faculty-guide.md", files["guides/faculty-guide.md"]),
              },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByRole("button", { name: "Faculty Guide", exact: true }).click();
      const reader = page.locator(".sidebar-file-view__markdown:visible");
      const link = reader.getByText("Development records", { exact: true });
      await link.waitFor();
      const chatUrl = page.url();
      const resolutions = (await gateway.getRequests("sessions.resolve")).length;
      await link.click();
      await expect
        .poll(
          async () =>
            page.url() !== chatUrl || (await gateway.getRequests("sessions.files.get")).length > 1,
        )
        .toBe(true);
      if (page.url() !== chatUrl) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("body"),
          [page.locator("body")],
          { animations: "disabled" },
        );
        await fs.writeFile(path.join(suite.artifactDir, "document-link-before.png"), frame.png);
      }
      expect(page.url()).toBe(chatUrl);
      const heading = reader.getByRole("heading", { name: section, exact: true });
      await heading.waitFor();
      const inReader = () =>
        heading.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const parent = element
            .closest(".sidebar-file-view__markdown-scroll")!
            .getBoundingClientRect();
          return bounds.top >= parent.top && bounds.bottom <= parent.bottom;
        });
      await expect.poll(inReader).toBe(true);
      const frame = await takeControlUiScreenshotFrame(page, reader, [heading], {
        animations: "disabled",
      });
      await fs.writeFile(path.join(suite.artifactDir, "document-link-after.png"), frame.png);
      const local = reader.getByText("Local records", { exact: true });
      await local.scrollIntoViewIfNeeded();
      await local.press("Enter");
      await expect.poll(inReader).toBe(true);
      expect(page.url()).toBe(chatUrl);
      expect(
        (await gateway.getRequests("sessions.files.get")).map((request) => request.params.path),
      ).toEqual([
        "guides/faculty-guide.md",
        "/workspace/guides/multiplayer-agentic-workflows.md",
        "/workspace/guides/multiplayer-agentic-workflows.md",
      ]);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(resolutions);
    });
  });
});
