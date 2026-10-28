import { expect, it } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS, INGRESS_GRANTABLE_OWNER_TOOLS } from "./dangerous-tools.js";

// A new owner-only tool must be a deliberate hook-grant decision, not drift.
it("lets hooks grant every owner-only tool except intent and automations", () => {
  expect([...INGRESS_GRANTABLE_OWNER_TOOLS].toSorted()).toEqual(
    GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
      (name) => name !== "intent" && name !== AUTOMATIONS_TOOL_NAME,
    ).toSorted(),
  );
});
