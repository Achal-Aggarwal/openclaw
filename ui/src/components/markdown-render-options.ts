import type { HumanMention } from "@openclaw/gateway-protocol";
import type { MarkdownJsonParser } from "./markdown-json.types.ts";

export type MarkdownHumanMentionToken = { marker: string; profileId: string; label: string };

// Larger message-mode inputs use the literal-text fallback instead of Markdown parsing.
export const MARKDOWN_PARSE_LIMIT = 40_000;

type MarkdownCommonOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: "copy" | "none";
  fileLinks?: boolean;
  humanMentions?: readonly HumanMention[];
  interactiveImages?: boolean;
  linkFavicons?: boolean;
  progressBars?: boolean;
  mode?: "document" | "message";
  remoteImages?: boolean;
  sessionLinks?: boolean;
  tableInteractions?: "enabled" | "none";
};

type StaticMarkdownOptions = {
  codeBlockInteraction?: "static";
  jsonParser?: MarkdownJsonParser;
};

/** Configuration accepted at a view boundary, before its JSON parser is ready. */
export type MarkdownInputOptions = MarkdownCommonOptions &
  (
    | StaticMarkdownOptions
    | { codeBlockInteraction: "interactive"; jsonParser?: MarkdownJsonParser }
  );

/** Interactive Markdown cannot render until its canonical JSON parser is prepared. */
export type MarkdownRenderOptions = MarkdownCommonOptions &
  (StaticMarkdownOptions | { codeBlockInteraction: "interactive"; jsonParser: MarkdownJsonParser });

export type MarkdownInputEnv = Required<MarkdownCommonOptions> & {
  codeBlockInteraction: "interactive" | "static";
  jsonParser?: MarkdownJsonParser;
  streamingOpenFence?: boolean;
  humanMentionTokens?: readonly MarkdownHumanMentionToken[];
};

export type MarkdownRenderEnv = Omit<MarkdownInputEnv, "codeBlockInteraction" | "jsonParser"> &
  (
    | { codeBlockInteraction: "static"; jsonParser?: MarkdownJsonParser }
    | { codeBlockInteraction: "interactive"; jsonParser: MarkdownJsonParser }
  );

export function normalizeMarkdownRenderOptions(options?: MarkdownRenderOptions): MarkdownRenderEnv;
export function normalizeMarkdownRenderOptions(options: MarkdownInputOptions): MarkdownInputEnv;
export function normalizeMarkdownRenderOptions(
  options: MarkdownInputOptions = {},
): MarkdownInputEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    codeBlockInteraction: options.codeBlockInteraction ?? "static",
    jsonParser: options.jsonParser,
    fileLinks: options.fileLinks ?? false,
    humanMentions: options.humanMentions ?? [],
    interactiveImages: options.interactiveImages ?? false,
    linkFavicons: options.linkFavicons ?? false,
    progressBars: options.progressBars ?? false,
    mode: options.mode ?? "message",
    remoteImages: options.remoteImages ?? options.mode === "document",
    sessionLinks: options.sessionLinks ?? false,
    tableInteractions: options.tableInteractions ?? "none",
  };
}
