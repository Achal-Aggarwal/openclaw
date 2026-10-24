import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const system = (subtype, fields) => send({ type: "system", subtype, ...fields });
const result = (answer, fields = {}) => send({ type: "result", subtype: "success",
  result: answer, session_id: "nested-fixture", num_turns: 1, stop_reason: "end_turn", ...fields });
const notification = (task_id) => system("task_notification", { task_id, status: "completed" });
const replay = (task_id) => send({ type: "user", isReplay: true, parent_tool_use_id: null,
  message: { content: "<task-notification><task-id>" + task_id + "</task-id></task-notification>" } });
const mode = process.env.NESTED_MODE;
const child = { task_id: "child", task_type: process.env.CHILD_TYPE, parent_task_id: "parent" };
const parent = { task_id: "parent", task_type: "local_agent" };
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    system("init", { capabilities: ["msg_lifecycle_v1"] });
    if (mode === "before-input") system("background_tasks_changed", { tasks: [parent, child] });
  } else if (message.type === "user") {
    input++;
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    if (input > 1) {
      if (mode === "old-input") {
        system("background_tasks_changed", { tasks: [parent, child] });
        notification("parent"); notification("child");
      }
      result("warm reply"); continue;
    }
    if (mode === "before-input") {
      system("background_tasks_changed", { tasks: [parent, child] }); result("unrelated reply"); continue;
    }
    system("task_started", { ...parent, is_backgrounded: mode === "foreground" ? false : true });
    if (mode !== "foreground" && mode !== "old-input") {
      system("background_tasks_changed", { tasks: [parent] }); result("waiting");
    }
    system("background_tasks_changed", { tasks: mode === "reverse-list" ? [child, parent] : [parent, child] });
    system("task_started", { ...child, is_backgrounded: true });
    if (mode === "old-input") {
      notification("child"); notification("parent"); result("first reply"); continue;
    }
    if (mode === "parent-first") {
      notification("parent"); replay("parent"); result("parent reply");
      notification("child"); replay("child"); result("forwarded child reply");
    } else if (mode === "foreground") {
      result("foreground reply");
    } else {
      notification("child");
      if (mode === "duplicate") notification("child");
      system("background_tasks_changed", { tasks: [parent] });
      notification("parent"); replay("parent"); result("parent reply");
    }
  }
}
`;

async function context(mode: string, childType = "local_agent") {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-nested-"));
  roots.push(root);
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, fixture);
  let current: CliBackendLiveSessionHandle | undefined;
  const liveSession: CliBackendLiveSessionCapability = {
    fingerprint: "nested-fixture",
    current: () => current,
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    remove: (handle) => {
      if (current === handle) current = undefined;
    },
    activate: () => {},
    restart: async () => {
      current?.close("restart");
      await current?.waitForExit();
    },
  };
  return {
    command: process.execPath,
    args: [script],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      NESTED_MODE: mode,
      CHILD_TYPE: childType,
    },
    prompt: "first",
    systemPrompt: "fixture",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession,
    timeoutMs: 1500,
    abortSignal: AbortSignal.timeout(2000),
    requestToolPermission: async () => ({ behavior: "deny", message: "unused" }),
    requestUserInput: async () => ({ status: "cancelled", message: "unused" }),
  } satisfies CliBackendExecuteContext;
}
async function collect(ctx: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(ctx)) records.push(record);
  return records.filter((record) => record.type === "result");
}
it.each(["local_agent", "local_workflow"])(
  "settles nested %s while its background parent consumes its notification",
  async (childType) => {
    const ctx = await context("child-first", childType);
    const results = await collect(ctx);
    expect(results.map((record) => record.result)).toEqual(["waiting", "parent reply"]);
    expect(results[0]).toHaveProperty("openclaw_interim_result", true);
    expect(results[1]).not.toHaveProperty("openclaw_interim_result");
    expect(ctx.liveSession.current()?.isIdle()).toBe(true);
    expect((await collect({ ...ctx, useResume: true, prompt: "next" }))[0]?.result).toBe(
      "warm reply",
    );
  },
);
