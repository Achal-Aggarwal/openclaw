import type { Node } from "jsonc-parser";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { t } from "../i18n/index.ts";
import { registerCodeBlocksEnglish } from "../i18n/locales/en-code-blocks.ts";
import { MARKDOWN_PARSE_LIMIT } from "./markdown-render-options.ts";

registerCodeBlocksEnglish();

const MAX_JSON_CHARS = 20_000;

export type MarkdownJson = { text: string; root?: Node };
export type MarkdownJsonParser = (text: string) => MarkdownJson | null;

/** Preserve the synchronous source/shape budgets before loading the tree parser. */
export function classifyMarkdownJson(text: string): "none" | "raw" | "parse" {
  if (text.length > MARKDOWN_PARSE_LIMIT) {
    return "none";
  }
  if (!/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(text.trim())) {
    return "none";
  }
  // Budget original whitespace too; these sources stay Raw rather than Markdown.
  return text.length > MAX_JSON_CHARS ? "raw" : "parse";
}

export function renderMarkdownJsonTree({ text, root }: MarkdownJson): string {
  if (!root) {
    return "";
  }
  const literal = (node: Node) => escapeHtml(text.slice(node.offset, node.offset + node.length));
  const renderNode = (node: Node, depth: number, prefix = "", suffix = ""): string => {
    const children = node.children ?? [];
    const type = node.type;
    const array = type === "array";
    if ((type !== "object" && !array) || children.length === 0) {
      const tone = type === "string" || type === "null" ? type : "literal";
      return `${prefix}<span class="code-block-json-value--${tone}">${literal(node)}</span>${suffix}`;
    }
    const opening = array ? "[" : "{";
    const closing = array ? "]" : "}";
    const summary = t(
      array
        ? children.length === 1
          ? "chat.codeBlock.jsonArrayItem"
          : "chat.codeBlock.jsonArrayItems"
        : "chat.codeBlock.jsonObjectKeys",
      { count: String(children.length) },
    );
    const rows = children
      .map((child, index) => {
        const property = child.type === "property";
        const key = property ? child.children?.[0] : undefined;
        const value = property ? child.children?.[1] : child;
        // Only an error-free AST reaches rendering; properties own a key and value.
        if (!value) {
          return "";
        }
        const label = key ? `<span class="code-block-json-key">${literal(key)}</span>: ` : "";
        return `<div class="code-block-json-row">${renderNode(value, depth + 1, label, index + 1 < children.length ? "," : "")}</div>`;
      })
      .join("");
    return `<details class="code-block-json-node"${depth < 2 ? " open" : ""}><summary>${prefix}<span class="code-block-json-node-opening">${opening}</span><span class="code-block-json-node-summary">${escapeHtml(summary)}${suffix}</span></summary><div class="code-block-json-children">${rows}</div><span class="code-block-json-bracket">${closing}${suffix}</span></details>`;
  };
  return `<div class="code-block-json-tree" data-markdown-key="json-tree">${renderNode(root, 0)}</div>`;
}

export function renderMarkdownJsonModes(): string {
  return `<div class="code-block-json-modes" data-markdown-key="json-modes" role="group" aria-label="${escapeHtml(t("chat.codeBlock.jsonView"))}">${(["tree", "raw"] as const).map((mode) => `<button type="button" class="code-block-json-mode" data-json-mode="${mode}" aria-pressed="${mode === "tree"}">${escapeHtml(t(mode === "tree" ? "chat.codeBlock.jsonTree" : "chat.codeBlock.jsonRaw"))}</button>`).join("")}</div>`;
}
