import { expect, it } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS, INGRESS_GRANTABLE_OWNER_TOOLS } from "./dangerous-tools.js";

// Tools that check the sender themselves stay out of hook grants; a new
// owner-only tool must be a deliberate grant decision, not drift.
const NOT_GRANTABLE = new Set([
  "intent",
  AUTOMATIONS_TOOL_NAME,
  "sessions",
  "portal",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
]);

it("lets hooks grant only owner-only tools without their own sender checks", () => {
  expect([...INGRESS_GRANTABLE_OWNER_TOOLS].toSorted()).toEqual(
    GATEWAY_OWNER_ONLY_CORE_TOOLS.filter((name) => !NOT_GRANTABLE.has(name)).toSorted(),
  );
});
