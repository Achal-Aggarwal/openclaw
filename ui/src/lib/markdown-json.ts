import {
  classifyMarkdownJson,
  type MarkdownJson,
  type MarkdownJsonParser,
} from "../components/markdown-json.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  type MarkdownInputOptions,
  type MarkdownRenderOptions,
} from "../components/markdown-render-options.ts";

let parser: MarkdownJsonParser | undefined;
const noJson: MarkdownJsonParser = () => null;

function loadMarkdownJsonParser(): MarkdownJsonParser | Promise<MarkdownJsonParser> {
  return (
    parser ??
    import("../components/markdown-json-parser.runtime.ts").then((runtime) => {
      parser = runtime.parseMarkdownJson;
      return parser;
    })
  );
}

/** Plain prose stays synchronous; JSON is classified before its view is published. */
export function prepareMarkdownJson(
  text: string,
): MarkdownJson | null | Promise<MarkdownJson | null> {
  const kind = classifyMarkdownJson(text);
  if (kind === "none") {
    return null;
  }
  if (kind === "raw") {
    return { text };
  }
  const ready = loadMarkdownJsonParser();
  return typeof ready === "function" ? ready(text) : ready.then((parse) => parse(text));
}

/** Every JSON object/array needs one of these characters, including fenced JSON. */
function prepareMarkdownJsonParser(text: string): MarkdownJsonParser | Promise<MarkdownJsonParser> {
  return /[\[{]/u.test(text) ? loadMarkdownJsonParser() : noJson;
}

/** Prepare once at the view boundary; synchronous Markdown rendering consumes this fact. */
export function prepareMarkdownJsonOptions(
  text: string,
  options: MarkdownInputOptions = {},
): MarkdownRenderOptions | Promise<MarkdownRenderOptions> {
  if (options.codeBlockInteraction !== "interactive") {
    return options;
  }
  // Oversized messages render literally; recovered/document views still parse their fences.
  const ready =
    options.mode !== "document" && text.length > MARKDOWN_PARSE_LIMIT
      ? noJson
      : prepareMarkdownJsonParser(text);
  return typeof ready === "function"
    ? { ...options, jsonParser: ready }
    : ready.then((jsonParser) => ({ ...options, jsonParser }));
}
