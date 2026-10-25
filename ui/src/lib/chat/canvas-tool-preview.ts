import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import type { ToolCard } from "./chat-types.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;
export type CanvasToolPreview = Extract<ToolPreview, { kind: "canvas" }>;

export function extractToolPreview(outputText: string | undefined): CanvasToolPreview | undefined {
  const preview = extractCanvasFromText(outputText);
  return preview?.surface === "assistant_message"
    ? { ...preview, surface: "assistant_message" }
    : undefined;
}
