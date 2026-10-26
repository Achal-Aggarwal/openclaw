// MCP CLI tests cover credential redaction in registry inspection output.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

async function withMcpHome(run: (home: string, workspaceDir: string) => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-home-", async (home) => {
    const workspaceDir = await createWorkspace();
    vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
    await run(home, workspaceDir);
  });
}

async function writeMcpServers(home: string, servers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(home, ".openclaw", "openclaw.json"),
    `${JSON.stringify({ mcp: { servers } })}\n`,
    "utf8",
  );
}

describe("mcp cli inspection redaction", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("redacts MCP registry inspection without changing saved credentials", async () => {
    await withMcpHome(async (home) => {
      vi.stubEnv("MCP_DISPLAY_TOKEN", "example-resolved-token-not-real");
      vi.stubEnv("MCP_DISPLAY_HEADER", "example-header-token-not-real");
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const servers = {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: {
            Authorization: "Bearer ${MCP_DISPLAY_HEADER}",
            "X-Goog-Api-Key": "example-maps-key-not-real",
            "X-Custom-Credential": "example-custom-header-not-real",
          },
        },
        local: {
          command: "node",
          args: ["server.mjs", "--api-key", "example-argv-key-not-real", "--region", "us-east-1"],
          env: {
            SERVICE_TOKEN: "example-env-token-not-real",
            REFERENCE: "${MCP_DISPLAY_TOKEN}",
          },
        },
      };
      await writeMcpServers(home, servers);

      for (const args of [
        ["list", "--json"],
        ["show", "--json"],
        ["show", "remote", "--json"],
        ["show", "local", "--json"],
        ["show"],
        ["show", "remote"],
        ["show", "local"],
      ]) {
        mockLog.mockClear();
        await runMcpCommand(["mcp", ...args]);
        const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
        for (const secret of [
          "example-header-token-not-real",
          "example-maps-key-not-real",
          "example-custom-header-not-real",
          "example-argv-key-not-real",
          "example-env-token-not-real",
          "example-resolved-token-not-real",
        ]) {
          expect(output, args.join(" ")).not.toContain(secret);
        }
        const inspected = JSON.parse(lastLogLine());
        if (args[1] !== "remote" && args[1] !== "local") {
          expect(inspected.remote.url).toBe("https://mcp.example.com/mcp");
          expect(inspected.local.args).toContain("us-east-1");
          expect(inspected.local.env.REFERENCE).toBe(REDACTED_SENTINEL);
        }
      }

      expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
      for (const name of ["remote", "local"]) {
        mockLog.mockClear();
        await runMcpCommand(["mcp", "show", name, "--json"]);
        await runMcpCommand(["mcp", "set", name, lastLogLine()]);
      }
      expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
    });
  });
});
