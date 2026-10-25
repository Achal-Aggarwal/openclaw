import type { GatewaySessionRow } from "../api/types.ts";
import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";

export const LONG_SESSION_SCENARIOS = ["mixed", "paging", "single-run", "direct-run"] as const;
export type LongSessionScenario = (typeof LONG_SESSION_SCENARIOS)[number];
export type LongSessionWorkload =
  | { scenario: "mixed" }
  | {
      scenario: "paging";
      messageCount: number;
      initialMessageCount: number;
      firstEntryId: string;
      pages: Array<{ offset: number; loadedMessages: number; anchorEntryId: string }>;
    }
  | {
      scenario: "single-run" | "direct-run";
      messageCount: number;
      firstEntryId: string;
      firstOutputEntryId: string;
      lastEntryId: string;
    };

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  richTranscript?: boolean;
  longSessionScenario?: LongSessionScenario;
  session?: GatewaySessionRow & { sessionId: string };
  historyStateReceipt?: boolean;
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
  if (
    options.longSessionScenario === "single-run" ||
    options.longSessionScenario === "direct-run"
  ) {
    const runId = "long-session-single-run";
    const historyMessages = messageIds.map((id, index) => {
      const first = index === 0;
      const last = index === messageIds.length - 1;
      const tool = !first && !last && index % 2 === 0;
      const toolCallId = `long-session-tool-${Math.floor((index - 1) / 2)}`;
      const hasToolCall = !first && !last && !tool && index + 1 < messageIds.length - 1;
      return {
        role: first ? "user" : tool ? "toolResult" : "assistant",
        __openclaw: {
          id,
          seq: index + 1,
          ...(first ? { idempotencyKey: `${runId}:user` } : { runId }),
        },
        timestamp: options.now - (options.messageCount - index) * 1_000,
        ...(tool ? { toolCallId, toolName: "read" } : {}),
        ...(!first && !tool
          ? {
              phase: last ? "final_answer" : "commentary",
              ...(hasToolCall ? { stopReason: "toolUse" } : last ? { stopReason: "stop" } : {}),
            }
          : {}),
        content: [
          {
            type: "text",
            text: first
              ? "Inspect these synthetic checkpoints in one run."
              : last
                ? "All synthetic checkpoints are ready."
                : tool
                  ? `Checkpoint ${index} contains synthetic material.`
                  : `### Project checkpoint ${index + 1}\n\nInspecting synthetic checkpoint.\n\n${index % 5 === 1 ? "```typescript\nconst ready = true;\n```" : "| Item | State |\n| --- | --- |\n| Fixture | Ready |"}`,
          },
          ...(hasToolCall
            ? [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "read",
                  arguments: { path: `checkpoint-${index}.md` },
                },
              ]
            : []),
        ],
      };
    });
    const workload: LongSessionWorkload = {
      scenario: options.longSessionScenario,
      messageCount: historyMessages.length,
      firstEntryId: messageIds[0]!,
      firstOutputEntryId: messageIds[1]!,
      lastEntryId: messageIds.at(-1)!,
    };
    return {
      messageIds,
      historyMessages,
      workload,
      pagination: undefined,
      configuredHistory: undefined,
    };
  }
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  const historyMessages = messageIds.map((id, index) => ({
    role:
      (options.largeSnapshot && index % 4 === 2) || (options.richTranscript && index % 8 === 6)
        ? "toolResult"
        : index % 2
          ? "assistant"
          : "user",
    __openclaw: { id, seq: index + 1 },
    ...(options.richTranscript && index % 8 === 6
      ? { toolCallId: `long-session-tool-${index - 1}`, toolName: "read" }
      : {}),
    ...(options.largeSnapshot
      ? {
          idempotencyKey: `synthetic-message-${index}`,
          ...(index % 4 === 2 ? { toolCallId: `synthetic-tool-${index}`, toolName: "read" } : {}),
          openclawResponsesInputReplay: { text: "Synthetic replay metadata. ".repeat(10) },
          usage: { input: 1200, output: 400, totalTokens: 1600 },
        }
      : {}),
    timestamp: options.now - (options.messageCount - index) * 60_000,
    content: [
      ...(options.attachments && index === options.messageCount - 1 ? options.attachments : []),
      {
        type: "text",
        text: [
          `### Project checkpoint ${index + 1}`,
          "Review the synthetic work queue, confirm the dependency order, and record the owner of the next action. The fixture contains no real conversations or account data.",
          index % 2
            ? "The current implementation is ready for verification. Coverage includes the normal path, a recoverable failure, and the final user-visible result."
            : "Please check the current progress and keep the existing layout stable while the remaining results arrive.",
          ...(options.largeSnapshot
            ? ["Synthetic transcript detail and tool output. ".repeat(40)]
            : []),
          ...(options.richTranscript
            ? [
                index === Math.floor(options.messageCount / 2) ? "long-session-search-needle" : "",
                index % 8 === 1
                  ? "```typescript\nconst checkpoints = [1, 2, 3];\nfor (const checkpoint of checkpoints) {\n  console.log({ checkpoint, ready: true });\n}\n```"
                  : index % 8 === 3
                    ? "| Check | Owner | Result |\n| --- | --- | --- |\n| Compile | Harbor | Passed |\n| Review | Scout | Ready |\n| Publish | Cedar | Pending |"
                    : "",
              ]
            : []),
          ...(options.inlineWidgets > 0 &&
          (index % messagesPerWidget === messagesPerWidget - 1 ||
            index === options.messageCount - 1)
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / messagesPerWidget) + 1}" title="Team metric ${Math.floor(index / messagesPerWidget) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
      ...(options.richTranscript && index % 8 === 5
        ? [
            {
              type: "toolCall",
              id: `long-session-tool-${index}`,
              name: "read",
              arguments: { path: "synthetic-checkpoint.md" },
            },
          ]
        : []),
      ...(options.richTranscript && index % 16 === 7
        ? [
            {
              type: "image",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a34sAAAAASUVORK5CYII=",
              alt: `Synthetic checkpoint image ${index + 1}`,
              width: 320,
              height: 180,
            },
          ]
        : []),
    ],
  }));
  const session = options.session;
  const configuredHistory =
    session && (options.largeSnapshot || options.historyStateReceipt)
      ? {
          messages: historyMessages,
          sessionId: session.sessionId,
          sessionInfo: session,
          hasMore: false,
          totalMessages: options.messageCount,
          metadata: { commands: [], models: [] },
          ...(options.historyStateReceipt
            ? {
                stateRevision: {
                  sessionInfo: "fixture-session-v1",
                  commands: "fixture-commands-v1",
                },
              }
            : {}),
        }
      : undefined;
  if (options.longSessionScenario !== "paging") {
    const workload: LongSessionWorkload = { scenario: "mixed" };
    return { messageIds, historyMessages, workload, pagination: undefined, configuredHistory };
  }
  if (!session) {
    throw new Error("Paged history fixture requires its session identity");
  }
  const initialMessageCount = Math.min(80, historyMessages.length);
  const pages = Array.from(
    { length: Math.ceil((historyMessages.length - initialMessageCount) / 1000) },
    (_, index) => {
      const offset = initialMessageCount + index * 1000;
      const loadedMessages = Math.min(offset + 1000, historyMessages.length);
      return {
        offset,
        loadedMessages,
        anchorEntryId: messageIds[historyMessages.length - offset]!,
        messages: historyMessages.slice(
          historyMessages.length - loadedMessages,
          historyMessages.length - offset,
        ),
      };
    },
  );
  const workload: LongSessionWorkload = {
    scenario: "paging",
    messageCount: historyMessages.length,
    initialMessageCount,
    firstEntryId: messageIds[0]!,
    pages: pages.map(({ offset, loadedMessages, anchorEntryId }) => ({
      offset,
      loadedMessages,
      anchorEntryId,
    })),
  };
  const initialResponse = {
    messages: historyMessages.slice(-initialMessageCount),
    hasMore: pages.length > 0,
    ...(pages.length ? { nextOffset: initialMessageCount } : {}),
    totalMessages: historyMessages.length,
    sessionId: session.sessionId,
    sessionInfo: session,
    metadata: { commands: [], models: [] },
  };
  const pagination = {
    deferredRequests: pages.map(({ offset }) => ({
      method: "chat.history",
      match: { sessionKey: session.key, offset },
    })),
    methodResponses: {
      "chat.startup": initialResponse,
      "chat.history": {
        cases: [
          ...pages.map(({ offset, loadedMessages, messages }) => ({
            match: { sessionKey: session.key, offset },
            response: {
              messages,
              hasMore: loadedMessages < historyMessages.length,
              ...(loadedMessages < historyMessages.length ? { nextOffset: loadedMessages } : {}),
              totalMessages: historyMessages.length,
              sessionId: session.sessionId,
            },
          })),
          { match: { sessionKey: session.key }, response: initialResponse },
        ],
      },
    },
  };
  return { messageIds, historyMessages, workload, pagination, configuredHistory };
}
