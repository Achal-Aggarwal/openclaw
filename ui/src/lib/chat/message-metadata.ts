import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";

export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  if (["user", "assistant", "system"].includes(lower)) {
    return lower;
  }
  if (["toolresult", "tool_result", "tool", "function"].includes(lower)) {
    return "tool";
  }
  return role;
}

export function hasToolMessageEnvelope(message: Record<string, unknown> | undefined): boolean {
  return (
    typeof message?.toolCallId === "string" ||
    typeof message?.tool_call_id === "string" ||
    typeof message?.toolUseId === "string" ||
    typeof message?.tool_use_id === "string" ||
    typeof message?.toolName === "string" ||
    typeof message?.tool_name === "string"
  );
}

export function resolveMessageRole(message: unknown): string {
  const m = asOptionalRecord(message);
  const content = m?.content;
  const hasToolContent =
    Array.isArray(content) &&
    content.some((value) => {
      const type = asOptionalRecord(value)?.type;
      return isToolResultContentType(type) || isToolCallContentType(type);
    });
  return hasToolContent || hasToolMessageEnvelope(m)
    ? "toolResult"
    : (readStringField(m, "role") ?? "unknown");
}

export function isToolResultMessage(message: unknown): boolean {
  return isToolResultContentType(asOptionalRecord(message)?.role);
}

export function isStandaloneToolMessageForDisplay(message: unknown): boolean {
  // Tool classification needs envelope fields, not parsed content or media.
  const m = asOptionalRecord(message);
  const role = typeof m?.role === "string" ? normalizeRoleForGrouping(m.role) : "unknown";
  return role === "tool" || hasToolMessageEnvelope(m);
}
