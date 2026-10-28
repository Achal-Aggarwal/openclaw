/** Doctor note for hook agent turns that run without owner-only tools. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "./health-checks.js";

const HOOKS_OWNER_TOOLS_CHECK_ID = "core/doctor/hooks-owner-tools";

/**
 * Hook agent turns lost the owner-only tools they had before they ran as
 * non-owners. Tells enabled hook users without a grant how to name the tools a
 * hook needs.
 */
export function detectHooksOwnerToolsFindings(cfg: OpenClawConfig): HealthFinding[] {
  const hooks = cfg.hooks;
  const granted =
    Boolean(hooks?.allowedOwnerTools?.length) ||
    (hooks?.mappings ?? []).some((mapping) => Boolean(mapping?.allowedOwnerTools?.length));
  if (hooks?.enabled !== true || granted) {
    return [];
  }
  return [
    {
      checkId: HOOKS_OWNER_TOOLS_CHECK_ID,
      category: "recommended",
      docsUrl: "https://docs.openclaw.ai/gateway/config-hooks#owner-only-tools",
      severity: "info",
      path: "hooks.mappings[].allowedOwnerTools",
      message:
        "Hook agent turns are not owners, so they get no owner-only tools such as gateway, nodes, terminal or conversations_send, and only control actions in sessions. Earlier versions gave embedded hook turns these tools.",
      fixHint:
        "If a hook needs gateway, plugins, nodes, computer, screen, mobile_ui, terminal or openclaw, list it in that mapping's allowedOwnerTools, or in hooks.allowedOwnerTools for direct /hooks/agent requests. Grant only what the hook needs.",
    },
  ];
}
