/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import {
  workspaceConflictPathForDisplay,
  workspaceResultConflictFromTranscript,
} from "./workspace-conflict.ts";

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat run error", () => {
  it.each(["run", "request"])(
    "strips only the decorative prefix from a %s error display and copies the raw diagnostic",
    async (source) => {
      // Compile the optional notice owner before testing its presentation.
      await import("./chat-view-notices-content.tsx");
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const diagnostic =
        "⚠️ 🛠️ Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const renderedDiagnostic =
        "  Error:  gateway disconnected near 🧭\n  indented\tdetail\n<img src=x onerror=alert(1)>\nFinal diagnostic line  ";
      const onDismissError = vi.fn();
      const onRetrySessionPlacementStartup = vi.fn();
      const container = renderChatView({
        ...(source === "run" ? { runError: { summary: diagnostic } } : { error: diagnostic }),
        onDismissError,
        onRetrySessionPlacementStartup,
      });

      await waitForSolid(() => expect(container.querySelector(".chat-error")).not.toBeNull());
      const alert = requireElement(container, ".chat-error", "chat run error");
      expect(alert.getAttribute("role")).toBe("alert");
      const details = requireElement(alert, "details", "error disclosure");
      expect(details.hasAttribute("open")).toBe(false);
      const fullDiagnostic = requireElement(details, "pre", "full diagnostic");
      expect(fullDiagnostic.textContent).toBe(renderedDiagnostic);
      expect(fullDiagnostic.getAttribute("aria-label")).toBe("Error details");
      expect(alert.textContent).not.toMatch(/[⚠🛠]/u);
      expect(alert.textContent).toContain("🧭");
      expect(alert.querySelector("img")).toBeNull();
      const summary = requireElement(details, "summary", "error header");
      expect(summary.textContent).toContain("Details");
      expect(summary.textContent).not.toContain("Error details");
      expect(alert.querySelectorAll(".chat-copy-btn")).toHaveLength(1);
      const copy = summary.querySelector<HTMLButtonElement>('[aria-label="Copy error"]');
      expect(copy).not.toBeNull();
      for (const open of [false, true]) {
        details.toggleAttribute("open", open);
        copy?.click();
        await waitForFast(() => expect(copy?.disabled).toBe(false));
        await waitForFast(() => expect(writeText).toHaveBeenCalledTimes(open ? 2 : 1));
        expect(writeText).toHaveBeenLastCalledWith(diagnostic);
        expect(details.hasAttribute("open")).toBe(open);
      }
      (summary as HTMLElement).click();
      expect(onDismissError).not.toHaveBeenCalled();
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
      expect(alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]') !== null).toBe(
        source === "request",
      );
      expect(
        alert.closest(source === "run" ? ".agent-chat__composer-notices" : ".chat-topbar-notices"),
      ).not.toBeNull();
      alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
      expect(onDismissError).toHaveBeenCalledTimes(source === "request" ? 1 : 0);
    },
  );

  it.each([true])("keeps startup Retry owned by retryable=%s", async (retryable) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onRetrySessionPlacementStartup = vi.fn();
    const container = renderChatView({
      placementStartup: {
        sessionKey: "agent:main:startup",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        error: "⚠️ Provisioning failed\n  Final diagnostic line  ",
        retryable,
      },
      onRetrySessionPlacementStartup,
    });
    await waitForSolid(() => expect(container.querySelector(".chat-error")).not.toBeNull());
    const alert = requireElement(container, ".chat-error", "startup error");
    expect(requireElement(alert, "pre", "startup diagnostic").textContent).toBe(
      "The session was created, but startup needs attention:  Provisioning failed\n  Final diagnostic line  ",
    );
    expect(alert.textContent).not.toContain("⚠");
    const details = requireElement(alert, "details", "startup disclosure");
    expect(requireElement(details, "summary", "startup header").textContent).toContain("Details");
    expect(requireElement(details, "pre", "startup diagnostic").getAttribute("aria-label")).toBe(
      "Error details",
    );
    const copy = details.querySelector<HTMLButtonElement>('summary [aria-label="Copy error"]');
    expect(copy).not.toBeNull();
    copy?.click();
    await waitForFast(() =>
      expect(writeText).toHaveBeenCalledWith(
        "The session was created, but startup needs attention: ⚠️ Provisioning failed\n  Final diagnostic line  ",
      ),
    );
    expect(details.hasAttribute("open")).toBe(false);
    alert.querySelector<HTMLElement>("summary")?.click();
    expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
    const retry = Array.from(alert.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(Boolean(retry)).toBe(retryable);
    retry?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledTimes(retryable ? 1 : 0);
  });
});

describe("cloud workspace conflict notice", () => {
  const conflict = {
    paths: [
      "src/[path]-1.ts",
      "src/path-2.ts",
      "src/path-3.ts",
      "src/path-4.ts",
      "src/path-5.ts",
      "src/path-6.ts",
    ],
    stagedResultRef: "refs/openclaw/worker-results/claim-123",
    totalCount: 9,
  };

  it("bounds conflict guidance and copies the selected path recovery command", async () => {
    await import("./chat-view-notices-content.tsx");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onDismissWorkspaceConflict = vi.fn();
    const container = renderChatView({
      workspaceConflict: conflict,
      onDismissWorkspaceConflict,
    });

    await waitForSolid(() =>
      expect(container.querySelector(".chat-workspace-conflict-notice")).not.toBeNull(),
    );
    const notice = requireElement(
      container,
      ".chat-workspace-conflict-notice",
      "workspace conflict notice",
    );
    expect(notice.closest(".agent-chat__composer-notices")).not.toBeNull();
    expect(notice.textContent).toContain("9 cloud workspace conflicts");
    expect(notice.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(notice.textContent).toContain("+4 more paths");
    expect(notice.textContent).toContain(conflict.stagedResultRef);
    expect(notice.textContent).toContain("Git Bash on Windows");
    expect(notice.textContent).toContain("file/directory conflict");
    expect(notice.textContent).toContain("cloud deleted it");
    expect(notice.textContent).toContain("staged ref is missing");

    const commands = [...notice.querySelectorAll(".chat-workspace-conflict-commands code")].map(
      (element) => element.textContent,
    );
    expect(commands).toEqual([
      "git show 'refs/openclaw/worker-results/claim-123:src/[path]-1.ts'",
      "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/[path]-1.ts'",
    ]);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy cloud inspect command"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      notice.querySelector<HTMLButtonElement>('[aria-label="Copy take-cloud command"]'),
    ).toBeInstanceOf(HTMLButtonElement);

    const rows = notice.querySelectorAll(".chat-workspace-conflict-paths li");
    rows[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(
      "git checkout 'refs/openclaw/worker-results/claim-123' -- ':(top,literal)src/path-2.ts'",
    );

    notice
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss workspace conflict notice"]')!
      .click();
    expect(onDismissWorkspaceConflict).toHaveBeenCalledTimes(1);
  });

  it.each(["\u0085"])(
    "keeps terminal-control paths visible without building copyable commands (%j)",
    async (controlSequence) => {
      const entryPath = `src/${controlSequence}unsafe.ts`;
      const normalizedConflict = workspaceResultConflictFromTranscript({
        role: "custom",
        customType: "cloud-workspace-conflict",
        details: {
          paths: [entryPath],
          stagedResultRef: "refs/openclaw/worker-results/claim-unsafe",
        },
      });
      expect(normalizedConflict).toBeDefined();
      const container = renderChatView({ workspaceConflict: normalizedConflict });
      await waitForSolid(() =>
        expect(container.querySelector(".chat-workspace-conflict-notice")).not.toBeNull(),
      );
      expect(container.querySelector(".chat-workspace-conflict-paths code")?.textContent).toBe(
        workspaceConflictPathForDisplay(entryPath),
      );
      expect(container.querySelector(".chat-workspace-conflict-commands")).toBeNull();
      expect(container.textContent).toContain("will not build a copyable shell command");
    },
  );
});
