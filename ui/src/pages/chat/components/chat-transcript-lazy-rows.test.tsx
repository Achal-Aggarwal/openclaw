/* @vitest-environment jsdom */

import { createSignal, onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasToolMessageDemand } from "../../../lib/chat/tool-message-demand.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createMessageGroup,
  createToolCall,
  createToolResultMessage,
} from "./chat-message.test-support.ts";
import { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { nativeRows, type NativeTranscriptView } from "./chat-transcript-rows.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function row(key: string, view: NativeTranscriptView): TestContentRow {
  return { kind: "content", key, content: new GuardedTranscriptItem([view], view) };
}

const group = (role: "user" | "assistant", content: string, timestamp: number) =>
  createMessageGroup({ role, content, timestamp }, role);

function firstCommittedRow<T>(
  read: (row: HTMLElement | null) => T,
  selector = ".chat-virtual-row",
) {
  let value: T | undefined;
  vi.stubGlobal("openclawRenderLifecycleTestHook", (host: object, phase: string) => {
    if (host instanceof ChatTranscriptRenderer && phase === "commit" && value === undefined) {
      value = read(host.columnElement?.querySelector<HTMLElement>(selector) ?? null);
    }
  });
  return () => value;
}

it("commits the first tool history row fully through the public chat thread", async () => {
  const history = attachHistoryActivity(
    prepareChatHistoryFixture([
      createAssistantMessage(
        [createToolCall("cached-read", "read", { path: "/workspace/notes.md" })],
        { timestamp: 1_000 },
      ),
      createToolResultMessage("cached-read", "read", "File unavailable", {
        timestamp: 2_000,
        isError: true,
      }),
    ]),
  );
  // Projection-only history uses the counted activity row instead of one inline tool card.
  const messages = [{ ...history.messages[0], content: [] }];
  expect(messages).toMatchObject([{ activity: [{ name: "read", status: "failed" }] }]);
  expect(messages.some(hasToolMessageDemand)).toBe(true);
  const paneId = "cold-tool-history";
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = createTestTranscript(paneId);
  const thread = createChatThreadHarness(container, transcript);
  const firstCommittedActivity = firstCommittedRow((row) =>
    row
      ? {
          summary: row.querySelector(".chat-activity-group__summary")?.textContent ?? null,
          failure: row.querySelector(".chat-tool-failure")?.textContent ?? null,
        }
      : null,
  );
  try {
    thread.render(
      threadProps(paneId, "agent:main:cold-tool-history", messages, {
        showToolCalls: true,
      }),
    );
    await waitForSolid(() => {
      expect(firstCommittedActivity()?.summary).toContain("1 read");
      expect(firstCommittedActivity()?.failure).toBe("1 failed");
    });
  } finally {
    transcript.dispose();
    thread.unmount();
    container.remove();
  }
});

it("commits a plain cached session update fully with its first transcript row", async () => {
  const message = {
    role: "assistant",
    content: "The cached session update",
    timestamp: 2,
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
  };
  expect(hasToolMessageDemand(message)).toBe(false);
  const update = createMessageGroup(message, "assistant", {
    senderSession: { sessionKey: "agent:main:source", label: "Source conversation" },
  });
  const firstCommit = firstCommittedRow(
    (row) => row?.textContent ?? null,
    '.chat-virtual-row[data-virtual-row-key="cached-session"]',
  );
  const view = await mountTestTranscript("cached-session", [
    row("cached-session", {
      kind: "group",
      group: update,
      options: { showReasoning: false },
    }),
  ]);
  try {
    expect(firstCommit()).toContain("Source conversation");
    expect(firstCommit()).toContain("The cached session update");
  } finally {
    view.transcript.dispose();
  }
});

it("commits a cached run's message body with its row shell and keeps it current", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const Frame = nativeRows.frame;
  const frameFor = (text: string) => {
    const answer = group("assistant", text, 3);
    return {
      kind: "agent-run-frame" as const,
      key: "run:cached",
      runId: "cached",
      boundaryId: "boundary",
      outcome: { kind: "completed" as const, actionOwner: answer.messages[0]! },
      parts: [answer],
    };
  };
  const [frame, setFrame] = createSignal(frameFor("The cached run answer"));
  let firstCommit: string | null = null;
  const view = mountSolid(
    () => {
      onSettled(() => {
        expect(container.querySelector(".chat-group.assistant")).not.toBeNull();
        firstCommit = container.textContent;
      });
      return (
        <Frame
          frame={frame()}
          options={{
            streamOptions: {},
            renderGroupOptions: () => ({ showReasoning: false }),
            isWorkExpanded: () => false,
            onToggleWork: () => {},
          }}
        />
      );
    },
    { container },
  );
  try {
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe(
      "The cached run answer",
    );
    flush();
    expect(firstCommit).toContain("The cached run answer");
    setFrame(frameFor("Current run answer"));
    flush();
    expect(container.querySelector(".chat-text")?.textContent?.trim()).toBe("Current run answer");
    expect(container.textContent).not.toContain("The cached run answer");
  } finally {
    view.unmount();
    container.remove();
  }
});

it("loads stream and run rows without losing the adjacent message or the latest snapshot", async () => {
  const message = group("user", "Keep this message", 1);
  const groupOptions = { showReasoning: false, onReply: () => {} };
  const stable = row("message", { kind: "group", group: message, options: groupOptions });
  const initial = row("tail", {
    kind: "group",
    group: group("assistant", "Before the run", 2),
    options: { showReasoning: false },
  });
  const view = await mountTestTranscript("lazy-transcript", [stable, initial]);
  try {
    await waitForSolid(() => expect(view.container.textContent).toContain("Keep this message"));
    const messageGroup = view.container.querySelector(".chat-group.user");
    expect(messageGroup).not.toBeNull();
    const reply = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reply to message"]',
    );
    expect(reply).not.toBeNull();
    reply!.focus();
    const stream = {
      kind: "stream" as const,
      key: "stream:answer",
      startedAt: 2,
      isStreaming: true,
      text: "Initial run snapshot",
      thinking: "",
    };
    view.renderRows([stable, row("tail", { kind: "stream", parts: [stream], options: {} })]);
    view.renderRows([
      row("message", {
        kind: "group",
        group: message,
        options: { ...groupOptions, assistantName: "Updated assistant" },
      }),
      row("tail", {
        kind: "stream",
        parts: [{ ...stream, text: "Latest run snapshot", isStreaming: false }],
        options: {},
      }),
    ]);
    await waitForSolid(() => expect(view.container.textContent).toContain("Latest run snapshot"));
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
    const answer = group("assistant", "Completed run answer", 3);
    const staleToggle = vi.fn();
    const currentToggle = vi.fn();
    const work = { key: "work", groups: [answer], durationMs: null };
    const renderTail = (tail: NativeTranscriptView) => view.renderRows([stable, row("tail", tail)]);
    const workRow = (onToggle: () => void): NativeTranscriptView => ({
      kind: "work",
      item: work,
      options: { expanded: false, onToggle },
    });
    renderTail(workRow(staleToggle));
    renderTail(workRow(currentToggle));
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-work-group button")).not.toBeNull(),
    );
    view.container.querySelector<HTMLButtonElement>(".chat-work-group button")!.click();
    expect(staleToggle).not.toHaveBeenCalled();
    expect(currentToggle).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
    renderTail({
      kind: "frame",
      frame: {
        kind: "agent-run-frame",
        key: "run:answer",
        runId: "run",
        boundaryId: "boundary",
        outcome: { kind: "completed", actionOwner: answer.messages[0]! },
        parts: [answer],
      },
      options: {
        streamOptions: {},
        renderGroupOptions: () => ({ showReasoning: false }),
        isWorkExpanded: () => false,
        onToggleWork: () => {},
      },
    });
    await waitForSolid(() => expect(view.container.textContent).toContain("Completed run answer"));
    flush();
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
  } finally {
    view.transcript.dispose();
  }
});
