/* @vitest-environment jsdom */
import { For, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { prepareChatToolPresentation } from "../../../lib/chat/tool-family.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it("retains standalone tool rows while updating arguments and mutation progress", async () => {
  await prepareChatToolPresentation([{ role: "toolResult", content: "Example output" }]);
  const toggle = vi.fn();
  const initialCard: ToolCard = {
    id: "exec",
    name: "tool_call",
    args: { id: "exec", args: { command: "echo before" } },
  };
  const [card, setCard] = createSignal(initialCard);
  const [mutations, setMutations] = createSignal<ToolCard[]>([
    {
      id: "edit",
      name: "edit",
      args: { path: "/repo/src/edit.ts", oldText: "before", newText: "after" },
      live: true,
      liveDiffStat: { added: 1, removed: 1 },
    },
    {
      id: "write",
      name: "write",
      args: { path: "/repo/src/write.ts", content: "new file\n" },
      live: true,
      liveDiffStat: { added: 1, removed: 0 },
    },
  ]);
  const root = mountSolid(() => (
    <>
      <ChatToolCard
        card={card()}
        options={{ messageKey: "lazy-row", expanded: false, onToggleExpanded: toggle }}
      />
      <For each={mutations()} keyed={(item) => item.id}>
        {(item) => (
          <section data-tool-case={item().name}>
            <ChatToolCard
              card={item()}
              options={{
                messageKey: item().id,
                expanded: false,
                onToggleExpanded: toggle,
                runActive: true,
              }}
            />
          </section>
        )}
      </For>
      <GroupedMessage
        preparation={prepareChatMessageRender({ role: "toolResult", content: "Example output" })}
        messageKey="tool-message"
        options={{ isStreaming: true, showReasoning: false }}
      />
      <ChatToolCard
        card={{
          id: "permission",
          name: "exec",
          details: {
            permissionMissing: {
              nodeId: "example-mac",
              nodeName: "Example Mac",
              command: "screen.capture",
              capabilities: ["screenRecording"],
              state: "denied",
            },
          },
        }}
        options={{ messageKey: "permission", expanded: false, onToggleExpanded: vi.fn() }}
      />
      <ChatToolCard
        card={{
          id: "progress",
          name: "progress_card",
          args: { plan: [{ step: "Read source", status: "completed" }] },
          completed: true,
        }}
        options={{ messageKey: "progress", expanded: false, onToggleExpanded: vi.fn() }}
      />
    </>
  ));
  onTestFinished(root.unmount);
  flush();
  await waitForSolid(() =>
    expect(root.container.querySelector(".chat-tool-row__cmd")?.textContent).toBe("echo before"),
  );
  const initialRow = root.container.querySelector<HTMLButtonElement>("button.chat-tool-row")!;
  expect(initialRow.disabled).toBe(false);
  expect(initialRow.querySelector(".chat-tool-disclosure__content")).not.toBeNull();
  expect(initialRow.querySelector(".chat-tool-row__chevron")).not.toBeNull();
  expect(root.container.querySelector(".chat-permission-card")).not.toBeNull();
  expect(root.container.querySelector(".chat-progress-card-receipt")).not.toBeNull();
  for (const [name, verb, removed] of [
    ["edit", "Editing", "-1"],
    ["write", "Writing", "-0"],
  ]) {
    const mutation = root.container.querySelector(`[data-tool-case="${name}"]`)!;
    expect(mutation.querySelector(".chat-tool-row[aria-busy]")).toBeNull();
    expect(mutation.querySelector(".chat-tool-row__verb")?.textContent).toBe(verb);
    expect(mutation.querySelector(".chat-tool-row__target")?.textContent).toBe(`${name}.ts`);
    expect(mutation.querySelector(".chat-diffstat__add")?.textContent).toBe("+1");
    expect(mutation.querySelector(".chat-diffstat__del")?.textContent).toBe(removed);
  }
  setMutations((items) =>
    items.map((item) => ({ ...item, liveDiffStat: { added: 4, removed: 2 } })),
  );
  flush();
  for (const mutation of root.container.querySelectorAll("[data-tool-case]")) {
    expect(mutation.querySelector(".chat-diffstat__add")?.textContent).toBe("+4");
    expect(mutation.querySelector(".chat-diffstat__del")?.textContent).toBe("-2");
  }
  setMutations((items) => items.map((item) => ({ ...item, live: false, completed: true })));
  flush();
  for (const [name, verb] of [
    ["edit", "Edited"],
    ["write", "Wrote"],
  ]) {
    const mutation = root.container.querySelector(`[data-tool-case="${name}"]`)!;
    expect(mutation.querySelector(".chat-tool-row__verb")?.textContent).toBe(verb);
  }
  setMutations([]);
  flush();
  setCard({ id: "current-exec", name: "exec", args: { command: "echo after" } });
  flush();
  await waitForSolid(() =>
    expect(root.container.querySelector(".chat-tool-row__cmd")?.textContent).toBe("echo after"),
  );
  expect(root.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(root.container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe("tool");
  const row = root.container.querySelector<HTMLButtonElement>("button.chat-tool-row")!;
  expect(root.container.querySelector(".chat-tool-row[aria-busy]")).toBeNull();
  row.click();
  expect(toggle).toHaveBeenCalledWith("current-exec");
  setCard({ id: "current-exec", name: "exec", args: { command: "echo latest" } });
  flush();
  expect(root.container.querySelector("button.chat-tool-row")).toBe(row);
  expect(root.container.querySelector(".chat-tool-row[aria-busy]")).toBeNull();
  expect(row.querySelector(".chat-tool-row__cmd")?.textContent).toBe("echo latest");
});
