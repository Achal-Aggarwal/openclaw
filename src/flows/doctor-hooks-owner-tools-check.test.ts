import { expect, it } from "vitest";
import { detectHooksOwnerToolsFindings } from "./doctor-hooks-owner-tools-check.js";

it("notes enabled hooks without an owner-tool grant", () => {
  expect(detectHooksOwnerToolsFindings({ hooks: { enabled: true, token: "t" } })).toEqual([
    expect.objectContaining({
      checkId: "core/doctor/hooks-owner-tools",
      severity: "info",
      fixHint: expect.stringContaining("allowedOwnerTools"),
    }),
  ]);
});

it("stays quiet once a hook grants owner-only tools or hooks are off", () => {
  expect(
    detectHooksOwnerToolsFindings({
      hooks: { enabled: true, token: "t", mappings: [{ allowedOwnerTools: ["nodes"] }] },
    }),
  ).toEqual([]);
  expect(
    detectHooksOwnerToolsFindings({
      hooks: { enabled: true, token: "t", allowedOwnerTools: ["gateway"] },
    }),
  ).toEqual([]);
  expect(detectHooksOwnerToolsFindings({ hooks: { enabled: false } })).toEqual([]);
});
