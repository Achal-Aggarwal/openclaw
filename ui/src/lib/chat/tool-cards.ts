import type { ToolCard, ToolCardOutcome } from "./chat-types.ts";
import { readChatToolFamily } from "./tool-family.ts";
import { hasToolMessageDemand } from "./tool-message-demand.ts";

export type { ToolPreview, CanvasToolPreview } from "./canvas-tool-preview.ts";
export { isToolCallContentBlock } from "./tool-message-demand.ts";

const emptyCards: ToolCard[] = [];

export function extractToolCardsCached(message: unknown): ToolCard[] {
  return hasToolMessageDemand(message)
    ? readChatToolFamily().extractToolCardsCached(message)
    : emptyCards;
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
