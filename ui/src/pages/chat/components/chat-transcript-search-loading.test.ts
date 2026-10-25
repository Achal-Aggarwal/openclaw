/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createReactiveDraftHarness, getComposerTextarea } from "../chat-view.test-helpers.ts";

it("retires a pending search and preserves the composer through the next search", async () => {
  const entered = createDeferred();
  const ready = createDeferred();
  const load = vi.fn(async () => {
    entered.resolve();
    await ready.promise;
    return vi.importActual<typeof import("./chat-transcript-search-content.tsx")>(
      "./chat-transcript-search-content.tsx",
    );
  });
  vi.doMock("./chat-transcript-search-content.tsx", load);
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  onTestFinished(() => {
    ready.resolve();
    platform.mockRestore();
    vi.doUnmock("./chat-transcript-search-content.tsx");
  });
  const { container } = createReactiveDraftHarness({
    paneId: "search-lazy-pane",
    messages: [{ role: "assistant", content: "Synthetic transcript text" }],
  });
  document.body.append(container);
  onTestFinished(() => container.remove());
  await waitForSolid(() =>
    expect(container.querySelector(".chat-thread")?.textContent).toContain(
      "Synthetic transcript text",
    ),
  );
  const composer = getComposerTextarea(container);
  composer.value = "Keep this draft";
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  composer.focus();
  const toggleSearch = () =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  expect(load).not.toHaveBeenCalled();
  toggleSearch();
  await entered.promise;
  expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
  expect(getComposerTextarea(container)).toBe(composer);
  expect(composer.value).toBe("Keep this draft");

  toggleSearch();
  flush();
  ready.resolve();
  await vi.dynamicImportSettled();
  expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
  expect(getComposerTextarea(container)).toBe(composer);

  toggleSearch();
  await waitForSolid(() =>
    expect(document.activeElement).toBe(container.querySelector(".agent-chat__search-bar input")),
  );
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() => expect(document.activeElement).toBe(composer));
  expect(container.querySelector(".agent-chat__search-bar")).toBeNull();
  expect(composer.value).toBe("Keep this draft");
  expect(getComposerTextarea(container)).toBe(composer);
  expect(load).toHaveBeenCalledOnce();
});
