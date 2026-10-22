import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  sendReadReceiptMatrix: vi.fn(async () => {}),
}));

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

afterEach(() => vi.restoreAllMocks());

describe("Matrix inbound command source", () => {
  it("does not tag an ordinary authorized room message as a text command", async () => {
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      groupAllowFrom: ["@user:example.org"],
      cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
      roomsConfig: { "!room:example.org": { requireMention: false } },
      shouldHandleTextCommands: () => true,
      hasControlCommand: (text) => text === "/status",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$ordinary-message",
        sender: "@user:example.org",
        body: "FYI: no reply needed",
        originServerTs: 123_456,
      }),
    );

    const ctxPayload = runPrepared.mock.calls[0]?.[0].ctxPayload;
    expect(ctxPayload).toMatchObject({
      CommandAuthorized: true,
      CommandTurn: { kind: "normal", source: "message" },
    });
    expect(ctxPayload?.CommandSource).toBeUndefined();
  });

  it("keeps text-command metadata for an authorized control command", async () => {
    const { handler, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      groupAllowFrom: ["@user:example.org"],
      cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
      roomsConfig: { "!room:example.org": { requireMention: false } },
      shouldHandleTextCommands: () => true,
      hasControlCommand: (text) => text === "/status",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$control-command",
        sender: "@user:example.org",
        body: "/status",
        originServerTs: 123_456,
      }),
    );

    expect(runPrepared.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      CommandSource: "text",
      CommandTurn: { kind: "text-slash", source: "text", authorized: true },
    });
  });
});
