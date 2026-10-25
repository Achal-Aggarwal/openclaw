import type { Node } from "jsonc-parser";

export type MarkdownJson = { text: string; root?: Node };
export type MarkdownJsonParser = (text: string) => MarkdownJson | null;
