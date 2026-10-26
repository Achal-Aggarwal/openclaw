import { describe, expect, it } from "vitest";
import { projectCloneInput, resolveProjectChip } from "./project-chip.ts";

const projects = [
  {
    id: "openclaw",
    displayName: "OpenClaw",
    repoRoot: "/workspace/openclaw",
    source: "registered" as const,
  },
];

describe("What chip state", () => {
  it("uses the selected project for the closed trigger", () => {
    expect(
      resolveProjectChip({
        folder: "/workspace/elsewhere",
        workspace: "/workspace",
        projectId: "openclaw",
        selectedRemoteProject: null,
        projects,
      }).label,
    ).toBe("OpenClaw");
  });

  it.each([
    ["https://github.com/openclaw/openclaw.git", true],
    ["git@github.com:openclaw/openclaw.git", true],
    ["file:///tmp/openclaw.git", false],
    ["--upload-pack=touch-pwned", false],
    ["https://github.com/openclaw/openclaw.git --config=evil", false],
  ])("recognizes safe clone input %s", (value, expected) => {
    expect(projectCloneInput(value) !== null).toBe(expected);
  });
});
