// Embedded runner tests cover recovery after an empty length stop.
import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { emptyLengthScenario, recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

describe("recoverEmbeddedRunAttempt after an empty length stop", () => {
  it.each(["pending", "delivered", "error"] as const)(
    "preserves %s source delivery after an empty length stop",
    async (state) => {
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        ...emptyLengthScenario,
        resolveReplyDelivery: async () => {
          if (state === "error") {
            throw new Error("delivery unavailable");
          }
          return state;
        },
      });
      expect(recovery).toEqual({ action: "proceed" });
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "[[reply_to_current]]"])(
    "continues after an earlier answer was delivered (reply target: %s)",
    async (preToolText) => {
      const previousAssistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "previous_reply",
            name: "message",
            arguments: { action: "send", message: "The previous result is ready." },
          },
        ],
      });
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        ...emptyLengthScenario,
        preToolText,
        precedingMessages: [
          { role: "user", content: "Send the previous result.", timestamp: 0 },
          previousAssistant,
          {
            role: "toolResult",
            toolCallId: "previous_reply",
            toolName: "message",
            content: [{ type: "text", text: "Delivered." }],
            isError: false,
            timestamp: 0,
          },
        ],
        answerSegments: [
          { textEnd: 0, messageEnd: 1, finalMessageStart: 1, lastAssistant: previousAssistant },
        ],
        resolveReplyDelivery: async (minimumAssistantMessageIndex = 0) =>
          minimumAssistantMessageIndex <= 1 ? "delivered" : "missing",
      });
      expect(recovery.action).toBe("retry");
      expect(continueFromCurrentTranscript).toHaveBeenCalledOnce();
    },
  );

  it("routes a zero-output length overflow to compaction before output retries", async () => {
    await expect(
      recoverAfterTransportDrop({
        assistant: buildEmbeddedRunnerAssistant({
          stopReason: "length",
          content: [],
          usage: createMockUsage(199000, 0),
        }),
        compactionEnabled: true,
      }),
    ).rejects.toThrow("overflow compaction requested");
  });
});
