import { isToolResultContentType } from "../../../../src/chat/tool-content.js";
import type { ToolCard, ToolCardOutcome } from "./chat-types.ts";
import { readChatToolFamily } from "./tool-family.ts";
import { hasToolMessageDemand, isToolCallContentBlock } from "./tool-message-demand.ts";

export type { ToolPreview, CanvasToolPreview } from "./canvas-tool-preview.ts";
export { isToolCallContentBlock } from "./tool-message-demand.ts";

const emptyCards: ToolCard[] = [];

export function extractToolCardsCached(message: unknown): ToolCard[] {
  return hasToolMessageDemand(message)
    ? readChatToolFamily().extractToolCardsCached(message)
    : emptyCards;
}

export function extractToolBlockCardsCached(
  message: Record<string, unknown>,
  block: Record<string, unknown>,
): ToolCard[] {
  return hasToolMessageDemand(message) ||
    isToolCallContentBlock(block) ||
    isToolResultContentType(block.type)
    ? readChatToolFamily().extractToolBlockCardsCached(message, block)
    : emptyCards;
}

export function isToolCardSkipped(card: ToolCard): boolean {
  return readChatToolFamily().isToolCardSkipped(card);
}

export function isToolCardError(card: ToolCard): boolean {
  return readChatToolFamily().isToolCardError(card);
}

export function resolveToolCardOutcome(
  card: ToolCard,
  runActive: boolean | undefined,
): ToolCardOutcome {
  return readChatToolFamily().resolveToolCardOutcome(card, runActive);
}

export function resolveToolCardDisplay(card: ToolCard): ToolCard {
  return readChatToolFamily().resolveToolCardDisplay(card);
}

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  return readChatToolFamily().formatCollapsedToolSummaryText(value);
}

export function formatDistinctCollapsedToolSummaryText(
  value: string | undefined,
  label: string | undefined,
): string | undefined {
  return readChatToolFamily().formatDistinctCollapsedToolSummaryText(value, label);
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  return readChatToolFamily().formatCollapsedToolPreviewText(value);
}

export function resolveCollapsedToolArgumentPreview(args: unknown): string | undefined {
  return readChatToolFamily().resolveCollapsedToolArgumentPreview(args);
}
