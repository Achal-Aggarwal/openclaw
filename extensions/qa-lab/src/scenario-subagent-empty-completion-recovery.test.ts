import fs from "node:fs/promises";
import path from "node:path";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const temporary = createTempDirHarness();
afterEach(() => temporary.cleanup());
const scenarioId = "subagent-empty-completion-recovery";
const acknowledgement = "QA-SUBAGENT-EMPTY-PARENT-ACK";
const notice = "No answer was returned. Ask again if you still need one.";
const faults = [
  ["notice-before", "unexpected missing-reply notice"],
  ["notice-after", "Gateway restart replayed child work"],
  ["suffixed-notice-before", "unexpected missing-reply notice"],
  ["suffixed-notice-after", "Gateway restart replayed child work"],
  ["duplicate-ack-before", "exactly one parent acknowledgement"],
  ["duplicate-ack-after", "Gateway restart replayed child work"],
  ["replace-ack", "Gateway restart replayed child work"],
  ["delete-ack", "Gateway restart replayed child work"],
  ["edit-ack", "Gateway restart replayed child work"],
  ["ack-timestamp-changed", "Gateway restart replayed child work"],
  ["completion-replay", "Gateway restart replayed child work"],
  ["finalization-replay", "Gateway restart replayed child work"],
  ["spawn-replay", "Gateway restart replayed child work"],
  ["write-replay", "repeated or changed the completed write"],
  ["write-event-replaced", "repeated or changed the completed write"],
  ["file-bytes-changed", "repeated or changed the completed write"],
  ["file-mtime-changed", "repeated or changed the completed write"],
  ["child-session-changed", "lost its failed terminal state"],
  ["requester-session-changed", "lost its failed terminal state"],
  ["new-run", "test condition was not met"],
  ["private-before", "leaked silence or internal metadata"],
  ["private-after", "Gateway restart replayed child work"],
  ["fabricated-final", "fabricated an assistant result"],
  ["finalization-tools", "two exhausted tool-free finalizations"],
] as const;
type Fault = (typeof faults)[number][0];

async function runEmptyCompletionFlow(fault?: Fault) {
  const scenario = readQaScenarioById(scenarioId);
  const config = scenario.execution.config!;
  const state = createQaBusState();
  const workspaceDir = await temporary.makeTempDir("empty-completion-flow-");
  const sideEffectPath = path.join(workspaceDir, String(config.sideEffectFile));
  const run = {
    label: "qa-terminal-empty",
    runId: "empty-run",
    childSessionKey: "child-session",
    requesterSessionKey: "parent-session",
    execution: { status: "terminal", outcome: { status: "error" } },
    delivery: { status: "delivered" },
  };
  const spawn = { plannedToolName: "sessions_spawn", plannedToolArgs: { label: run.label } };
  const write = { plannedToolName: "write", plannedToolArgs: { path: config.sideEffectFile } };
  const finalization = {
    raw: `Subagent terminal reply QA worker: empty. ${String(config.settledToolRetryNeedle)}`,
    body: { tools: fault === "finalization-tools" ? [{ name: "write" }] : [] },
  };
  const requests = [spawn, write, finalization, structuredClone(finalization)];
  let restarted = false;
  let sent = false;
  const snapshot = state.getSnapshot;
  state.getSnapshot = () => {
    const result = snapshot();
    if (restarted && fault === "ack-timestamp-changed") {
      result.messages = result.messages.map((message) =>
        message.text === acknowledgement
          ? { ...message, timestamp: message.timestamp + 1 }
          : message,
      );
    }
    return result;
  };
  let conversation = "";
  let acknowledgementId = "";
  const send = (text: string) =>
    state.addOutboundMessage({ accountId: "default", to: `dm:${conversation}`, text });
  const addNotice = (suffix: boolean) =>
    send(notice + (suffix ? " A tool may already have changed external state." : ""));
  const transcript = () => ({
    assistantToolCallCounts: { write: restarted && fault === "write-replay" ? 2 : 1 },
    completedToolCallCounts: { write: 1 },
    successfulToolCallCounts: { write: 1 },
    successfulToolCallEvents: [
      {
        name: "write",
        toolCallId: restarted && fault === "write-event-replaced" ? "new-write" : "write-once",
      },
    ],
    finalText: restarted && fault === "fabricated-final" ? "fabricated success" : "",
  });

  return await runLoadedScenarioFlow(scenarioId, {
    state,
    api: {
      fs,
      path,
      env: {
        providerMode: "mock-openai",
        gateway: {
          workspaceDir,
          call: async (method: string) => {
            expect(method).toBe("agent.wait");
            return {
              status: "error",
              error: "exhausted empty completion",
              stopReason: "error",
              livenessState: "abandoned",
              terminalReply: { disposition: "empty" },
              terminalReceipt: { terminalDisposition: "not-visible" },
            };
          },
        },
        mock: {
          baseUrl: "http://qa.invalid",
          terminalRequesters: { settle: async () => undefined },
        },
      },
      transport: {
        sendInbound: async (input: QaBusInboundMessageInput) => {
          const inbound = state.addInboundMessage(input);
          conversation = input.conversation.id;
          sent = true;
          await fs.writeFile(sideEffectPath, String(config.sideEffectContents));
          acknowledgementId = send(acknowledgement).id;
          if (fault === "notice-before" || fault === "suffixed-notice-before") {
            addNotice(fault === "suffixed-notice-before");
          }
          if (fault === "duplicate-ack-before") {
            send(acknowledgement);
          }
          if (fault === "private-before") {
            send(String(config.metadataSentinel));
          }
          return inbound;
        },
      },
      readNativeQaSubagentRuns: async () => {
        const restored = structuredClone(run);
        if (restarted) {
          if (fault === "new-run") {
            restored.runId = "another-run";
          }
          if (fault === "child-session-changed") {
            restored.childSessionKey = "another-child";
          }
          if (fault === "requester-session-changed") {
            restored.requesterSessionKey = "another-parent";
          }
        }
        return [restored];
      },
      readSessionTranscriptSummary: async () => transcript(),
      recentOutboundSummary: () => JSON.stringify(state.getSnapshot().messages),
      fetchJson: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/debug/request-cursor") {
          return { cursor: sent ? 1 : 0 };
        }
        if (!restarted) {
          return requests;
        }
        switch (fault) {
          case "completion-replay":
            return [{ raw: "[Internal task completion event]" }];
          case "finalization-replay":
            return [finalization];
          case "spawn-replay":
            return [spawn];
          case "write-replay":
            return [write];
          default:
            return [];
        }
      },
      restartGatewayWithConfigPatch: async () => {
        restarted = true;
        if (fault === "notice-after" || fault === "suffixed-notice-after") {
          addNotice(fault === "suffixed-notice-after");
        }
        if (fault === "duplicate-ack-after" || fault === "replace-ack") {
          send(acknowledgement);
        }
        if (fault === "delete-ack" || fault === "replace-ack") {
          state.deleteMessage({ accountId: "default", messageId: acknowledgementId });
        }
        if (fault === "edit-ack") {
          state.editMessage({
            accountId: "default",
            messageId: acknowledgementId,
            text: "changed ACK",
          });
        }
        if (fault === "private-after") {
          send(String(config.metadataSentinel));
        }
        if (fault === "write-replay") {
          await fs.writeFile(sideEffectPath, String(config.sideEffectContents));
        }
        if (fault === "file-bytes-changed") {
          await fs.writeFile(sideEffectPath, "changed side effect");
        }
        if (fault === "file-mtime-changed") {
          const stat = await fs.stat(sideEffectPath);
          await fs.utimes(sideEffectPath, stat.atime, new Date(stat.mtimeMs + 10000));
        }
      },
    },
  });
}

describe("exhausted empty subagent scenario", () => {
  it("retains the failed child and quiet completion across restart without replaying work", async () => {
    const result = await runEmptyCompletionFlow();
    expect(result.status).toBe("pass");
    const details = JSON.parse(result.steps[0]!.details!);
    expect(details).toMatchObject({
      runId: "empty-run",
      execution: { outcome: { status: "error" } },
      delivery: { status: "delivered" },
      childFinalText: "",
      finalizationCount: 2,
      requesterAcknowledgementCount: 1,
      expectedNoticeCount: 0,
      actualNoticeCount: 0,
      postRestartNoticeCount: 0,
      postRestartCompletionRequestCount: 0,
    });
    expect(details.postRestartAcknowledgements).toEqual([
      { ...details.requesterAcknowledgement, deleted: false },
    ]);
    expect(details.restoredSuccessfulWriteEvents).toEqual(details.successfulWriteEvents);
  });

  it.each(faults)("rejects %s observations in the actual loaded flow", async (fault, failure) => {
    await expect(runEmptyCompletionFlow(fault)).rejects.toThrow(failure);
  });
});
