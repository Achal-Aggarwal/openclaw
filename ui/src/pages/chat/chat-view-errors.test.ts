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
