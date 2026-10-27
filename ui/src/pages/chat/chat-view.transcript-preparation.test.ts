/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chatProgress from "./chat-progress.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import { createMessageGroup } from "./components/chat-message.test-support.ts";
import {
  RealtimeTalkConversation,
  TurnRecapRow,
} from "./components/chat-transcript-specialized.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat loading skeleton", () => {
  it("retires only the exact saved Talk entries, retaining unsaved speech and repeated words", async () => {
    await RealtimeTalkConversation.preload();
    const container = renderChatView({
      realtimeTalkActive: true,
      messages: [{ role: "user", content: "Repeated words", __openclaw: { id: "voice:call:1" } }],
      readRealtimeTalkConversation: () => [
        {
          id: "u1",
          role: "user",
          text: "Repeated words",
          isStreaming: false,
          transcriptId: "voice:call:1",
        },
        {
          id: "u2",
          role: "user",
          text: "Repeated words",
          isStreaming: false,
          transcriptId: "voice:call:2",
        },
        { id: "a1", role: "assistant", text: "Still speaking", isStreaming: true },
      ],
    });
    const turns = [...container.querySelectorAll(".agent-chat__voice-turn")];
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "You Repeated words",
      "Val Still speaking",
    ]);
  });

  it("keeps a completed recap after later tool content", async () => {
    await TurnRecapRow.preload();
    vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValueOnce([
      createMessageGroup(
        { role: "assistant", content: "Interim answer", timestamp: 1 },
        "assistant",
      ),
      createMessageGroup({ role: "tool", content: "Later tool result", timestamp: 2 }, "tool"),
    ]);
    vi.spyOn(chatProgress, "resolveTurnRecap").mockReturnValue({
      runId: "run-composed",
      runtimeMs: 5_000,
      outputTokens: 42,
    });

    const container = renderChatView({
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
    });

    expect(container.querySelector(".chat-group.assistant .chat-turn-recap")).toBeNull();
    expect(container.querySelector(".chat-turn-recap")?.textContent).toContain("Done in");
  });
});
