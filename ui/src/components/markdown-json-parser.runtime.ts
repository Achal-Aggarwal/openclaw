import { createScanner, parseTree, type ParseError } from "jsonc-parser";
import { classifyMarkdownJson } from "./markdown-json.ts";
import type { MarkdownJson } from "./markdown-json.types.ts";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_TOKENS = 4_000;

export function parseMarkdownJson(text: string): MarkdownJson | null {
  const kind = classifyMarkdownJson(text);
  if (kind === "none") {
    return null;
  }
  if (kind === "raw") {
    return { text };
  }
  // jsonc-parser preserves ordered duplicate members and offsets, but recurses.
  // Scan before parsing; oversized trees retain complete literal Raw/Copy content.
  const scanner = createScanner(text, true);
  let depth = 0;
  let tokens = 0;
  // The scanner gives whole string tokens, so braces inside strings never affect depth.
  // EOF has an empty span; no runtime import of the package's ambient const enums is needed.
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const delimiter = text[scanner.getTokenOffset()];
    if (delimiter === "{" || delimiter === "[") {
      depth += 1;
    }
    if (delimiter === "}" || delimiter === "]") {
      depth -= 1;
    }
    if (depth > MAX_JSON_DEPTH || ++tokens > MAX_JSON_TOKENS) {
      try {
        JSON.parse(text);
        return { text };
      } catch {
        return null;
      }
    }
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  return root && errors.length === 0 ? { text, root } : null;
}
