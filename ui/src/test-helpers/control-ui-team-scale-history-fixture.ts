import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  richTranscript?: boolean;
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
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
  return { messageIds, historyMessages };
}
