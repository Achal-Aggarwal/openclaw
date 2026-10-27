/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewTestState } from "./chat-view-reset.test-support.ts";
import { renderChatInto, requireElement } from "./chat-view.test-helpers.ts";
import { installTranscriptDomMocks } from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetChatViewTestState);

describe("cloud worker disk-space notice", () => {
  it("updates persistent disk guidance and clears it after recovery", async () => {
    await import("./chat-view-notices-content.tsx");
    const container = createComposerContainer();
    renderChatInto(container, {
      diskSpace: { status: "warning", availableBytes: 400, totalBytes: 1_000, observedAtMs: 1 },
    });
    await waitForSolid(() =>
      expect(container.querySelector(".chat-cloud-disk-space-notice")).not.toBeNull(),
    );
    renderChatInto(container, {
      diskSpace: {
        status: "critical",
        availableBytes: 50 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024 * 1024,
        observedAtMs: 1_000,
      },
    });
    const notice = requireElement(container, ".chat-cloud-disk-space-notice", "disk-space notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("Cloud session disk space is critically low");
    expect(notice.textContent).toContain("New writes may fail and stop the agent.");
    expect(notice.querySelector("svg")).not.toBeNull();
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.closest(".chat-topbar-notices")).not.toBeNull();
    renderChatInto(container, {
      diskSpace: { status: "ok", availableBytes: 800, totalBytes: 1_000, observedAtMs: 2 },
    });
    expect(container.querySelector(".chat-cloud-disk-space-notice")).toBeNull();
  });
});
