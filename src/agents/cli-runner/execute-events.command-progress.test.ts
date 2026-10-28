import { expect, it, vi } from "vitest";
import {
  buildChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
} from "../../channels/streaming.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { createSessionControllerWatchdog } from "../../sessions/session-controller.watchdog.js";
import type { CliToolUseStartDelta } from "../cli-output-contracts.js";
import {
  claudeMessageStart,
  claudeStreamEvent,
  createClaudeParser,
  joinJsonlFrames,
} from "../cli-output.test-helpers.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { createCliToolTracking, type CliToolTracking } from "./execute-tool-tracking.js";

it("keeps native Bash detail without asserting ambiguous MCP execution", () => {
  const runId = "cli-bash-progress";
  const context = buildContext(runId);
  const tracking = {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
  } as unknown as CliToolTracking;
  const handlers = createCliEventHandlers({
    context,
    toolTracking: tracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId) {
      events.push(event);
    }
  });
  const complete = (
    toolCallId: string,
    name: string,
    kind: CliToolUseStartDelta["kind"],
    command: string,
    result: string,
  ) => {
    handlers.emitParsedToolUseStart({ toolCallId, name, kind, args: { command } });
    handlers.emitParsedToolResult({ toolCallId, name, isError: false, result });
  };
  try {
    complete("bash-1", "Bash", "tool_use", "echo retained", "retained");

    const start = events.find((event) => event.stream === "tool" && event.data.phase === "start");
    const end = events.find((event) => event.stream === "item" && event.data.phase === "end");
    expect(end?.data).toMatchObject({
      status: "completed",
      meta: expect.stringContaining("echo retained"),
    });
    const options = { commandText: "raw" as const, detailMode: "raw" as const };
    const startLine = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "Bash",
        toolCallId: "bash-1",
        args: start?.data.args as Record<string, unknown>,
      },
      options,
    );
    const endLine = buildChannelProgressDraftLine(
      {
        event: "item",
        name: "Bash",
        toolCallId: "bash-1",
        itemId: "tool:bash-1",
        itemKind: "tool",
        status: "completed",
        commandBearing: true,
        meta: end?.data.meta as string | undefined,
      },
      options,
    );
    if (!startLine || !endLine) {
      throw new Error("expected Bash progress lines");
    }
    expect(
      mergeChannelProgressDraftLine([startLine], endLine, { maxLines: 4 })[0]?.detail,
    ).toContain("echo retained");

    for (const [toolCallId, name, expectedName, kind] of [
      ["mcp-1", "mcp__openclaw__exec", "exec", "mcp_tool_use"],
      ["mcp-generic-1", "mcp__openclaw__exec", "exec", "tool_use"],
      ["mcp-gemini-1", "mcp_openclaw_exec", "exec", "tool_use"],
      ["mcp-third-party-1", "mcp_docs_exec", "mcp_docs_exec", "tool_use"],
    ] as const) {
      complete(toolCallId, name, kind, "requested command", "result with ambiguous execution");
      const mcpTerminal = events.find(
        (event) =>
          event.stream === "item" &&
          event.data.phase === "end" &&
          event.data.toolCallId === toolCallId,
      );
      expect(mcpTerminal?.data).toMatchObject({ status: "completed", name: expectedName });
      expect(mcpTerminal?.data.meta).toBeUndefined();
    }
  } finally {
    dispose();
  }
});

it.each(["text", "tokens after message reset"])(
  "keeps fresh %s alive through the real JSONL/handler/watchdog path",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stop = vi.fn(() => "settled" as const);
    const watchdog = createSessionControllerWatchdog({
      startedAtMs: 0,
      isCurrent: () => true,
      readPhase: () => "active",
      requestStop: stop,
      expireCleanup: stop,
    });
    const attempt = watchdog.attachAttempt({ assertCurrent() {} });
    attempt.setExecutionDeadline(600_000);
    const context = buildContext("thinking-progress");
    context.params.diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      ...context.params,
      watchdogAttempt: attempt,
    });
    const handlers = createCliEventHandlers({
      context,
      toolTracking: createCliToolTracking(context),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const parser = createClaudeParser({
      onAssistantDelta: handlers.emitCliAssistantDelta,
      onThinkingDelta: handlers.emitCliThinkingDelta,
      onThinkingProgress: handlers.emitCliThinkingProgress,
    });
    const push = (...frames: unknown[]) => parser.push(joinJsonlFrames(...frames, ""));
    const thinking = (text: string, tokens?: number) =>
      claudeStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: text, estimated_tokens: tokens },
      });
    try {
      push(claudeMessageStart("message-a"), thinking("", 100));
      vi.setSystemTime(359_000);
      push(
        ...(kind === "text"
          ? [thinking("New analysis")]
          : [claudeMessageStart("message-b"), thinking("", 1)]),
      );
      vi.setSystemTime(360_000);
      expect(await watchdog.tick()).toMatchObject({ action: "observe", reason: "progress" });
      expect(stop).not.toHaveBeenCalled();
      expect(watchdog.snapshot().semanticDeadlineAtMs).toBe(719_000);
      vi.setSystemTime(600_000);
      expect(await watchdog.tick()).toMatchObject({ action: "stop", reason: "execution_deadline" });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      watchdog.close();
      vi.useRealTimers();
    }
  },
);
