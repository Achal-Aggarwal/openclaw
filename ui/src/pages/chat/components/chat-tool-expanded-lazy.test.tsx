/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { prepareChatToolPresentation } from "../../../lib/chat/tool-family.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

const loading = vi.hoisted(() => {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return { promise, release, entered, enter, started: false };
});
vi.mock("./chat-tool-expanded.solid.tsx", async (original) => {
  loading.started = true;
  loading.enter();
  await loading.promise;
  return original();
});

it("loads details on expansion and leaves a collapsed card closed when loading finishes", async () => {
  onTestFinished(loading.release);
  await Promise.race([
    prepareChatToolPresentation([{ role: "toolResult", content: "Example output" }]),
    loading.entered.then(() => {
      throw new Error("Preparing collapsed presentation must not load expanded details");
    }),
  ]);
  expect(loading.started).toBe(false);
  const [expanded, setExpanded] = createSignal(false);
  const [card, setCard] = createSignal<ToolCard>({
    id: "exec",
    name: "exec",
    args: { command: "echo before" },
    outputText: "before",
  });
  const root = mountSolid(() => (
    <ChatToolCard
      card={card()}
      options={{
        messageKey: "lazy-tool",
        expanded: expanded(),
        onToggleExpanded: () => setExpanded((value) => !value),
      }}
    />
  ));
  onTestFinished(root.unmount);
  flush();
  expect(loading.started).toBe(false);
  setExpanded(true);
  flush();
  await vi.waitFor(() => expect(loading.started).toBe(true));
  setCard({ id: "exec", name: "exec", args: { command: "echo after" }, outputText: "after" });
  setExpanded(false);
  flush();
  loading.release();
  await vi.dynamicImportSettled();
  flush();
  expect(root.container.querySelector(".chat-tool-card")).toBeNull();
  setExpanded(true);
  flush();
  await vi.dynamicImportSettled();
  flush();
  await waitForSolid(() =>
    expect(root.container.querySelector(".chat-tool-term__out code")?.textContent).toBe("after"),
  );
});
