/** Security audit findings for the hooks HTTP ingress surface. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuthForConfig, type ResolvedGatewayAuth } from "../gateway/auth-resolve.js";
import { resolveAllowedAgentIds } from "../gateway/hooks-policy.js";
import { type GatewayAuthAuditOptions, isGatewayRemotelyExposed } from "./audit-extra.sync.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type GatewayAuthSharedSecretLabel = "gateway auth token" | "gateway auth password";
type GatewayAuthSharedSecretReuse = {
  label: GatewayAuthSharedSecretLabel;
  source: "config" | "override";
};

function findHooksTokenGatewayAuthReuse(params: {
  hooksToken: string;
  configGatewayAuth: ResolvedGatewayAuth;
  overrideGatewayAuth?: ResolvedGatewayAuth;
}): GatewayAuthSharedSecretReuse | undefined {
  for (const [source, auth] of [
    ["config", params.configGatewayAuth],
    ["override", params.overrideGatewayAuth],
  ] as const) {
    if (!auth) {
      continue;
    }
    if (auth.mode === "token" && normalizeOptionalString(auth.token) === params.hooksToken) {
      return { label: "gateway auth token", source };
    }
    if (
      (auth.mode === "password" || auth.mode === "trusted-proxy") &&
      normalizeOptionalString(auth.password) === params.hooksToken
    ) {
      return { label: "gateway auth password", source };
    }
  }
  return undefined;
}

export function collectHooksHardeningFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: GatewayAuthAuditOptions = {},
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.hooks?.enabled !== true) {
    return findings;
  }

  const token = normalizeOptionalString(cfg.hooks?.token) ?? "";
  if (token && token.length < 24) {
    findings.push({
      checkId: "hooks.token_too_short",
      severity: "warn",
      title: "Hooks token looks short",
      detail: `hooks.token is ${token.length} chars; prefer a long random token.`,
    });
  }

  const configGatewayAuth = resolveGatewayAuthForConfig({
    config: cfg,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const overrideGatewayAuth = options.gatewayAuthOverride
    ? resolveGatewayAuthForConfig({
        config: cfg,
        authOverride: options.gatewayAuthOverride,
        tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
        env,
      })
    : undefined;
  const reusedGatewayAuth = findHooksTokenGatewayAuthReuse({
    hooksToken: token,
    configGatewayAuth,
    overrideGatewayAuth,
  });
  if (reusedGatewayAuth) {
    const password = reusedGatewayAuth.label === "gateway auth password";
    findings.push({
      checkId: "hooks.token_reuse_gateway_token",
      severity: "critical",
      title: `Hooks token reuses the Gateway ${password ? "password" : "token"}`,
      detail: password
        ? "hooks.token matches gateway.auth password; a stolen hooks token also grants Gateway password access."
        : "hooks.token matches gateway.auth token; a stolen hooks token also grants Gateway API access.",
      remediation:
        reusedGatewayAuth.source === "override"
          ? "Rotate hooks.token or the runtime Gateway shared-secret auth value used for this audit; doctor can only repair reuse that is present in persisted config or process env."
          : `Run ${formatCliCommand("openclaw doctor --fix")} to rotate a persisted hooks.token, then update external hook senders to use the new hook token.`,
    });
  }

  const rawPath = normalizeOptionalString(cfg.hooks?.path) ?? "";
  if (rawPath === "/") {
    findings.push({
      checkId: "hooks.path_root",
      severity: "critical",
      title: "Hooks base path is '/'",
      detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
      remediation: "Use a dedicated path like '/hooks'.",
    });
  }

  const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
  const defaultSessionKey = normalizeOptionalString(cfg.hooks?.defaultSessionKey) ?? "";
  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes)
    ? cfg.hooks.allowedSessionKeyPrefixes
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0)
    : [];
  const remoteExposure = isGatewayRemotelyExposed(cfg);

  if (!defaultSessionKey) {
    findings.push({
      checkId: "hooks.default_session_key_unset",
      severity: "warn",
      title: "hooks.defaultSessionKey is not configured",
      detail:
        "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
      remediation: 'Set hooks.defaultSessionKey (for example, "hook:ingress").',
    });
  }

  if (allowedAgentIds === undefined) {
    findings.push({
      checkId: "hooks.allowed_agent_ids_unrestricted",
      severity: remoteExposure ? "critical" : "warn",
      title: "Hook agent routing allows any configured agent",
      detail:
        "hooks.allowedAgentIds is unset or includes '*', so authenticated hook callers may route to any configured agent id, including the default agent when agentId is omitted.",
      remediation:
        'Set hooks.allowedAgentIds to an explicit allowlist (for example, ["hooks", "main"]) or [] to deny hook agent routing.',
    });
  }

  if (allowRequestSessionKey) {
    findings.push({
      checkId: "hooks.request_session_key_enabled",
      severity: remoteExposure ? "critical" : "warn",
      title: "External hook payloads may override sessionKey",
      detail:
        "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
      remediation:
        "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes.",
    });
  }

  const ownerToolGrants = describeHookOwnerToolGrants(cfg.hooks);
  if (ownerToolGrants.length > 0) {
    findings.push({
      checkId: "hooks.owner_tools_granted",
      severity: "warn",
      title: "Hook agent turns may use owner-only tools",
      detail: `Hook payloads are untrusted, yet these hooks grant owner-only tools to their agent turns: ${ownerToolGrants.join("; ")}.`,
      remediation:
        "Remove allowedOwnerTools entries the hook does not need, and keep the hook token, allowedAgentIds and the target agent's tools narrow.",
    });
  }

  if (allowRequestSessionKey && allowedPrefixes.length === 0) {
    findings.push({
      checkId: "hooks.request_session_key_prefixes_missing",
      severity: remoteExposure ? "critical" : "warn",
      title: "Request sessionKey override is enabled without prefix restrictions",
      detail:
        "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
      remediation:
        'Set hooks.allowedSessionKeyPrefixes (for example, ["hook:"]) or disable request overrides.',
    });
  }

  return findings;
}

// One line per hook entry that grants owner-only tools, naming its config path.
function describeHookOwnerToolGrants(hooks: OpenClawConfig["hooks"]): string[] {
  const grants: string[] = [];
  if (hooks?.allowedOwnerTools?.length) {
    grants.push(`hooks.allowedOwnerTools (${hooks.allowedOwnerTools.join(", ")})`);
  }
  for (const [index, mapping] of (hooks?.mappings ?? []).entries()) {
    if (mapping?.allowedOwnerTools?.length) {
      const label = normalizeOptionalString(mapping.id) ?? String(index);
      grants.push(
        `hooks.mappings[${label}].allowedOwnerTools (${mapping.allowedOwnerTools.join(", ")})`,
      );
    }
  }
  return grants;
}
