import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { hasToolMessageEnvelope } from "./message-metadata.ts";

export function isToolCallContentBlock(item: {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
}): boolean {
  return (
    isToolCallContentType(item.type) ||
    (typeof item.name === "string" &&
      (item.arguments != null || item.args != null || item.input != null))
  );
}

/** A false result proves the message needs no tool-family projection. */
export function hasToolMessageDemand(message: unknown): boolean {
  const value = asOptionalObjectRecord(message);
  if (!value) {
    return false;
  }
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  if (
    isToolResultContentType(role) ||
    role === "tool" ||
    role === "function" ||
    hasToolMessageEnvelope(value) ||
    value["__openclawToolStreamLive"] === true ||
    value["__openclawToolStreamResultReceived"] === true ||
    value["__openclawToolStreamItemEnded"] === true ||
    value["__openclawToolStreamDiffStat"] != null ||
    value["__openclawToolStreamReceivedAt"] != null ||
    (value.activity != null && (!Array.isArray(value.activity) || value.activity.length > 0))
  ) {
    return true;
  }
  return (
    Array.isArray(value.content) &&
    value.content.some((entry) => {
      const block = asOptionalObjectRecord(entry);
      return Boolean(
        block && (isToolCallContentBlock(block) || isToolResultContentType(block.type)),
      );
    })
  );
}
