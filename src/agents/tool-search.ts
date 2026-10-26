import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { bindGatewayToolPolicyControl } from "./agent-tool-metadata.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { isLocalModelLeanEnabled } from "./local-model-lean.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import {
  attachInternalToolResultContentSource,
  copyInternalToolResultState,
} from "./runtime/internal-hooks.js";
import { bindAgentToolReplaySafety } from "./tool-replay-safety.js";
import { resolveToolResultFailureKind } from "./tool-result-error.js";
import {
  INCOMPLETE_INSTRUCTIONS_HINT,
  applyToolCatalogCompaction,
  collectUniqueCatalogToolNames,
  toolSchemaDirectoryPromptCache,
  visibleCatalogEntries,
  isDirectVisibleCatalogTool,
  resolveCatalog,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { renderToolSearchControlText } from "./tool-search-control-result.js";
import {
  prepareToolSearchDispatcherArguments,
  readToolSearchCallArgs,
  readToolSearchId,
  readToolSearchRequest,
} from "./tool-search-request.js";
import {
  formatToolSearchControlError,
  formatToolSearchControlResult,
  ToolSearchRuntime,
} from "./tool-search-runtime.js";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS,
  MAX_TOOL_SEARCH_RESULTS,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchMode,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { textResult, ToolInputError, type AnyAgentTool } from "./tools/common.js";

export {
  clearToolSearchCatalog,
  collectUniqueCatalogToolNames,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
export { resolveToolSearchConfig } from "./tool-search-config.js";
export {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search-types.js";
export type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
  ToolSearchConfig,
  ToolSearchToolContext,
} from "./tool-search-types.js";

const MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS = 18_000;
const TOOL_DIRECTORY_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function applyToolSchemaDirectoryCatalog(params: {
  tools: AnyAgentTool[];
  config?: Parameters<typeof resolveToolSearchConfig>[0];
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: Parameters<typeof applyToolCatalogCompaction>[0]["toolHookContext"];
  directToolNames?: Iterable<string>;
}) {
  const config = resolveToolSearchConfig(params.config);
  if (!config.enabled || !params.tools.some((tool) => tool.name === TOOL_SEARCH_RAW_TOOL_NAME)) {
    return applyToolCatalogCompaction({
      ...params,
      enabled: config.enabled,
      isVisibleControlTool: () => false,
    });
  }
  const directToolNames = new Set(normalizeStringEntries(Array.from(params.directToolNames ?? [])));
  const uniqueCatalogToolNames = collectUniqueCatalogToolNames(params.tools);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    selection: config,
    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    // The unique-name gate defers any cross-source name collision before the
    // shared trust check runs.
    isVisibleCatalogTool: (tool) =>
      uniqueCatalogToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
  });
}

export function buildToolSchemaDirectoryPrompt(
  ctx: ToolSearchToolContext,
  options?: CatalogVisibilityOptions & {
    contextTokenBudget?: number;
    toolSearchDirectoryLean?: boolean;
  },
): string {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const catalog = resolveCatalog(ctx);
  const contextTokens = options?.contextTokenBudget;
  // At four characters per token, the listing gets 2.5% of the active window.
  // Keep enough room for discovery instructions even in a very small window.
  const maxChars =
    contextTokens && Number.isFinite(contextTokens) && contextTokens > 0
      ? Math.min(
          MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS,
          Math.max(768, Math.floor(contextTokens / 10)),
        )
      : MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS;
  // Lean filtering must not buy longer descriptions for the remaining tools.
  const descriptionMaxChars =
    (options?.toolSearchDirectoryLean ?? isLocalModelLeanEnabled(ctx)) ? 0 : 180;
  const cacheKey = `${config.mode}:${options?.includeMcp === false ? "without-mcp" : "all"}:${maxChars}:${descriptionMaxChars}`;
  let cachedPrompts = toolSchemaDirectoryPromptCache.get(catalog.entries);
  // Caller-owned filters may change in place; cached text must not bypass them.
  const cachedPrompt = options?.allowedIds ? undefined : cachedPrompts?.get(cacheKey);
  if (cachedPrompt !== undefined) {
    return cachedPrompt;
  }
  const prompt = formatToolSearchCatalogDirectory(
    visibleCatalogEntries(catalog, options),
    config.mode,
    maxChars,
    descriptionMaxChars,
  );
  if (options?.allowedIds) {
    return prompt;
  }
  if (!cachedPrompts) {
    cachedPrompts = new Map<string, string>();
    toolSchemaDirectoryPromptCache.set(catalog.entries, cachedPrompts);
  }
  cachedPrompts.set(cacheKey, prompt);
  pruneMapToMaxSize(cachedPrompts, 12);
  return prompt;
}

export function resolveToolSearchCatalogTool(
  ctx: ToolSearchToolContext,
  name: unknown,
  options?: CatalogVisibilityOptions,
): AnyAgentTool | undefined {
  const catalog = ctx.catalogRef?.current;
  const needle = typeof name === "string" ? name.trim() : "";
  if (!needle || !catalog) {
    return undefined;
  }
  const matches = visibleCatalogEntries(catalog, options).filter((entry) => entry.name === needle);
  return matches.length === 1 && !matches[0]?.requiresExactId
    ? (matches[0]?.tool as AnyAgentTool | undefined)
    : undefined;
}

function compactDirectoryDescription(description: string, maxChars: number): string {
  // Collapsing whitespace only shrinks text, so a normalized raw window longer than the
  // limit already proves truncation without normalizing the whole description.
  const window = description.slice(0, maxChars * 4);
  let normalized = window.replace(/\s+/g, " ").trimStart();
  if (window.length === description.length) {
    normalized = normalized.trimEnd();
  } else if (normalized.length <= maxChars + 1) {
    normalized = description.replace(/\s+/g, " ").trim();
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, maxChars - 3).trimEnd()}...`;
}

function formatToolDirectoryIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && TOOL_DIRECTORY_IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

type ToolDirectoryRow = { label: string; description: string };

function prepareToolDirectoryRow(entry: ToolSearchCatalogEntry): ToolDirectoryRow | undefined {
  if (entry.source !== "openclaw") {
    return undefined;
  }
  const name = formatToolDirectoryIdentifier(entry.name);
  if (!name) {
    return undefined;
  }
  const ownerName = formatToolDirectoryIdentifier(entry.sourceName);
  return {
    label: `- ${name}${ownerName ? ` (${ownerName})` : ""}`,
    description: entry.description,
  };
}

function formatToolDirectoryRow(row: ToolDirectoryRow, descriptionMaxChars: number): string {
  if (descriptionMaxChars === 0) {
    return row.label;
  }
  const description = compactDirectoryDescription(row.description, descriptionMaxChars);
  return `${row.label}: ${description || "No description."}`;
}

function formatToolSearchCatalogDirectory(
  entries: ToolSearchCatalogEntry[],
  mode: ToolSearchMode,
  maxChars: number,
  initialDescriptionMaxChars: number,
): string {
  const deferredEntries = entries.filter((entry) => !entry.directVisible);
  if (deferredEntries.length === 0) {
    return "Available deferred-schema tools: none.";
  }
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  // Count collisions before excluding native tools: their lookalikes remain ambiguous.
  const listedEntries = deferredEntries
    .filter((entry) => !entry.requiresExactId && nameCounts.get(entry.name) === 1)
    .toSorted(
      (left, right) =>
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  const rows = listedEntries
    .map(prepareToolDirectoryRow)
    .filter((row): row is ToolDirectoryRow => row !== undefined);
  let descriptionMaxChars = initialDescriptionMaxChars;
  const renderRows = () => rows.map((row) => formatToolDirectoryRow(row, descriptionMaxChars));
  let lines = renderRows();
  const heading = "Available deferred-schema tools:";
  const notice = "Policy-approved MCP and client tools may also be discoverable through search.";
  const omittedLabel = " additional tools omitted. ";
  // Each line includes its newline; three fixed separators remain outside the rows.
  let lineChars = lines.reduce((chars, line) => chars + line.length + 1, 0);
  let omitted = deferredEntries.length - lines.length;
  let guidance: string;
  for (;;) {
    guidance =
      omitted > 0
        ? "Use tool_search to find a tool and its input signature; use tool_describe when a full schema is needed."
        : "Use tool_search for a compact input signature or tool_describe for a full schema.";
    if (mode === "tools") {
      guidance +=
        " Deferred names are not directly callable. Call dispatch_action with the result id or name in id and all tool parameters in args. Use this wrapper even when other guidance names a deferred tool directly.";
    } else if (mode === "directory") {
      guidance +=
        " Call a unique deferred tool name directly, or use dispatch_action with its id and args.";
    }
    const footerChars =
      guidance.length + (omitted > 0 ? String(omitted).length + omittedLabel.length : 0);
    if (
      heading.length + lineChars + notice.length + footerChars + 3 <= maxChars ||
      lines.length === 0
    ) {
      break;
    }
    // Preserve capability names before dropping rows; full descriptions remain searchable.
    if (descriptionMaxChars > 0) {
      descriptionMaxChars = descriptionMaxChars === 180 ? 64 : 0;
      lines = renderRows();
      lineChars = lines.reduce((chars, line) => chars + line.length + 1, 0);
      continue;
    }
    // SAFETY: this renderer owns the nonempty, dense formatted-line array.
    // Remove excluded rows before materializing the bounded directory.
    lineChars -= lines.pop()!.length + 1;
    omitted += 1;
  }
  const footer = omitted > 0 ? `${omitted}${omittedLabel}${guidance}` : guidance;
  return [heading, ...lines, "", notice, footer].join("\n");
}

type ToolSearchCandidate = Awaited<ReturnType<ToolSearchRuntime["search"]>>[number];
type ToolSearchBatchGroup = {
  query: string;
  candidates: ToolSearchCandidate[];
  truncated?: true;
};
const MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS = 180;
const MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS = MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS * 4;
const MAX_BATCH_CANDIDATE_METADATA_CHARS = 2_000;
function compactBatchCandidateDescription(candidate: ToolSearchCandidate): ToolSearchCandidate {
  // Remote catalog descriptions are untrusted. Bound the scanned prefix before
  // normalization so repeated batch matches cannot amplify attacker-sized text.
  const prefix = truncateUtf16Safe(
    candidate.description,
    MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS,
  );
  const normalized = prefix.replace(/\s+/g, " ").trim();
  if (
    prefix.length === candidate.description.length &&
    normalized.length <= MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS
  ) {
    return { ...candidate, description: normalized };
  }
  const compacted = truncateUtf16Safe(
    normalized,
    MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS - 3,
  ).trimEnd();
  return {
    ...candidate,
    description: `${compacted}...`,
  };
}

function compactBatchCandidate(candidate: ToolSearchCandidate): ToolSearchCandidate | undefined {
  // Callable identity must stay exact. Optional provenance/display metadata is
  // omitted when it would make a repeated batch candidate attacker-sized.
  const mandatoryChars =
    candidate.id.length + candidate.source.length + candidate.name.length + candidate.input.length;
  if (mandatoryChars > MAX_BATCH_CANDIDATE_METADATA_CHARS) {
    return undefined;
  }
  let remaining = MAX_BATCH_CANDIDATE_METADATA_CHARS - mandatoryChars;
  const retain = (value: string | undefined): string | undefined => {
    if (value === undefined || value.length > remaining) {
      return undefined;
    }
    remaining -= value.length;
    return value;
  };
  const sourceName = retain(candidate.sourceName);
  const label = retain(candidate.label);
  const mcpChars = candidate.mcp
    ? candidate.mcp.serverName.length +
      candidate.mcp.safeServerName.length +
      candidate.mcp.toolName.length +
      candidate.mcp.operation.length
    : 0;
  const mcp = candidate.mcp && mcpChars <= remaining ? candidate.mcp : undefined;
  if (mcp) {
    remaining -= mcpChars;
  }
  // Keep short guidance in batch discovery. If attacker-sized or budget-limited
  // text cannot fit, retain an explicit pointer to the complete metadata owner.
  const instructions = mcp ? retain(mcp.instructions) : undefined;
  const omittedInstructions = Boolean(
    (candidate.instructionsHint || candidate.mcp?.instructions) && !instructions,
  );
  const batchMcp = mcp
    ? {
        serverName: mcp.serverName,
        safeServerName: mcp.safeServerName,
        toolName: mcp.toolName,
        operation: mcp.operation,
        ...(instructions ? { instructions } : {}),
      }
    : undefined;
  const output = retain(candidate.output);
  const instructionsHint =
    candidate.instructionsHint ?? (omittedInstructions ? INCOMPLETE_INSTRUCTIONS_HINT : undefined);
  return {
    ...compactBatchCandidateDescription(candidate),
    sourceName,
    label,
    mcp: batchMcp,
    output,
    ...(instructionsHint ? { instructionsHint } : {}),
  };
}

function formatToolSearchBatchResponse(
  results: ToolSearchBatchGroup[],
  networkContent: boolean,
): AgentToolResult<{
  results: ToolSearchBatchGroup[];
  truncated?: true;
}> {
  const bounded: ToolSearchBatchGroup[] = results.map((result) => {
    const candidates = result.candidates
      .map(compactBatchCandidate)
      .filter((candidate): candidate is ToolSearchCandidate => candidate !== undefined);
    const groupTruncated = candidates.length < result.candidates.length;
    return {
      ...result,
      candidates,
      ...(groupTruncated ? { truncated: true as const } : {}),
    };
  });
  let truncated = bounded.some((result) => result.truncated);
  const render = () => ({ results: bounded, ...(truncated ? { truncated: true as const } : {}) });
  let payload = render();
  let { text } = renderToolSearchControlText(JSON.stringify(payload, null, 2), networkContent);
  while (text.length > MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS) {
    let removable: ToolSearchBatchGroup | undefined;
    for (const group of bounded) {
      if (group.candidates.length === 0) {
        continue;
      }
      // Keep the earlier request on exact ties, matching the batch's stable order.
      if (
        !removable ||
        group.candidates.length > removable.candidates.length ||
        (group.candidates.length === removable.candidates.length &&
          JSON.stringify(group.candidates.at(-1)).length >
            JSON.stringify(removable.candidates.at(-1)).length)
      ) {
        removable = group;
      }
    }
    if (!removable) {
      break;
    }
    removable.candidates.pop();
    removable.truncated = true;
    truncated = true;
    payload = render();
    ({ text } = renderToolSearchControlText(JSON.stringify(payload, null, 2), networkContent));
  }
  const result = textResult(text, payload);
  return networkContent ? attachInternalToolResultContentSource(result, "network") : result;
}

function shouldExposeControlTool(name: string, mode: ToolSearchMode): boolean {
  return mode === "tools" && TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(name);
}

/** Replace visible tools with Tool Search controls and register hidden catalog entries. */
export function applyToolSearchCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
  directToolNames?: Iterable<string>;
}) {
  const config = resolveToolSearchConfig(params.config);
  const directToolNames = new Set(normalizeStringEntries(Array.from(params.directToolNames ?? [])));
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    selection: config,
    isVisibleControlTool: (tool) => shouldExposeControlTool(tool.name, config.mode),
    isVisibleCatalogTool: (tool) => isDirectVisibleCatalogTool(tool, directToolNames),
  });
}

const describeParameters = Type.Object({
  id: Type.String({ description: "Tool search result id or tool name." }),
});
const callParameters = Type.Object({
  id: Type.String({ description: "Tool search result id or tool name." }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." })),
});
// The resolved limit is bounded to 1..MAX_TOOL_SEARCH_RESULTS. Stable source schemas
// let the session descriptor owner reuse its normalized, published parameters.
const searchParametersByLimit = new Map<number, AnyAgentTool["parameters"]>();

function resolveSearchParameters(searchDefaultLimit: number): AnyAgentTool["parameters"] {
  const cached = searchParametersByLimit.get(searchDefaultLimit);
  if (cached) {
    return cached;
  }
  const parameters = Type.Object({
    query: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "Single search query, in English. A non-empty query joins a non-empty batch first. Null or blank is ignored beside a non-empty batch.",
      }),
    ),
    limit: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
        description:
          "Maximum number of single-search results. Omitted or null uses the default. With only batch queries, omit this or set it to null; set limits on each batch entry.",
      }),
    ),
    queries: Type.Optional(
      Type.Union(
        [
          // Let the parser handle empty or null batch placeholders beside a scalar.
          Type.Array(
            Type.Object({
              query: Type.String({
                minLength: 1,
                maxLength: MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
                description: "Search query, in English. Describe the capability you need.",
              }),
              limit: Type.Optional(
                Type.Integer({
                  minimum: 1,
                  description: `Maximum results for this query. Defaults to ${searchDefaultLimit} when omitted.`,
                }),
              ),
            }),
            { maxItems: MAX_TOOL_SEARCH_BATCH_QUERIES },
          ),
          Type.Null(),
        ],
        {
          description: `Independent searches. Prefer this alone for several searches; a non-empty query beside it runs as the first entry. Their effective limits may total at most ${MAX_TOOL_SEARCH_RESULTS}; an omitted item limit counts as ${searchDefaultLimit}. The serialized query strings may use at most ${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes in total.`,
        },
      ),
    ),
  });
  searchParametersByLimit.set(searchDefaultLimit, parameters);
  return parameters;
}

export function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[] {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const runtime = new ToolSearchRuntime(ctx, config, { validateInput: true });
  return [
    {
      name: TOOL_SEARCH_RAW_TOOL_NAME,
      label: "Tool Search",
      description:
        "Search the effective Tool Search catalog. Pass query for one search or queries for several independent searches in one call; a non-empty query joins a non-empty batch first, with its own limit. Batch results stay grouped in request order. Queries must be in English: matching is lexical against tool names and descriptions, which are written in English, so another language will usually match nothing. Pass an exact result id or name to dispatch_action. Use tool_describe when you need its input schema or when a result includes instructionsHint; call it before dispatch_action to load the complete server instructions.",
      parameters: resolveSearchParameters(config.searchDefaultLimit),
      execute: async (toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const request = readToolSearchRequest(args, config);
        if (request.kind === "single") {
          return formatToolSearchControlResult(
            await runtime.search(request.search.query, {
              limit: request.search.limit,
              parentToolCallId: toolCallId,
            }),
            runtime,
            { parentToolCallId: toolCallId },
          );
        }
        const results = await Promise.all(
          request.searches.map(async (search) => ({
            query: search.query,
            candidates: await runtime.search(search.query, {
              limit: search.limit,
              parentToolCallId: toolCallId,
            }),
          })),
        );
        return formatToolSearchBatchResponse(results, runtime.hasNetworkContent(toolCallId));
      },
    },
    {
      name: TOOL_DESCRIBE_RAW_TOOL_NAME,
      label: "Tool Describe",
      description:
        "Load the full schema and metadata, including complete server instructions, for one tool id or name. Use this when the input is not already clear or when discovery returned instructionsHint.",
      parameters: describeParameters,
      prepareArguments: prepareToolSearchDispatcherArguments,
      execute: async (toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        formatToolSearchControlResult(
          await runtime.describe(readToolSearchId(args), { parentToolCallId: toolCallId }),
          runtime,
          { parentToolCallId: toolCallId },
        ),
    },
    {
      name: TOOL_CALL_RAW_TOOL_NAME,
      label: "Tool Call",
      description:
        "Call an exact Tool Search result id or name through OpenClaw. If arguments are not already clear, call tool_describe with the same id for the full description and schema; do not guess omitted fields from compact input hints.",
      parameters: callParameters,
      prepareArguments: prepareToolSearchDispatcherArguments,
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> => {
        const catalog = resolveCatalog(ctx);
        const call = readToolSearchCallArgs(args, catalog);
        try {
          if (
            ctx.catalogRef?.directOnlyToolNames?.has(call.id) &&
            !catalog.entries.some((entry) => entry.id === call.id || entry.name === call.id)
          ) {
            throw new ToolInputError(
              "This tool is already available directly, not through the tool catalog. Call it directly by its declared name with its declared parameters.",
            );
          }
          const callResult = await runtime.call(call.id, call.input, {
            parentToolCallId: toolCallId,
            signal,
            onUpdate,
          });
          const { id, name, source } = callResult.tool;
          const { details: _details, ...modelResult } = callResult.result;
          const images = callResult.result.content.filter((block) => block.type === "image");
          if (images.length > 0) {
            modelResult.content = modelResult.content.filter((block) => block.type !== "image");
          }
          // Invocation results need identity, not another copy of the discovery metadata.
          // Keep the full target result in details; forward its already-projected images as content.
          const controlResult = formatToolSearchControlResult(
            { tool: { id, name, source }, result: modelResult },
            runtime,
            { parentToolCallId: toolCallId, images },
          );
          const failureKind = resolveToolResultFailureKind(callResult.result);
          // Keep the model-visible `{ tool, result }` envelope stable while the
          // outer lifecycle reads its own canonical failure marker from details.
          return copyInternalToolResultState(controlResult, {
            ...controlResult,
            details: failureKind ? { ...callResult, status: failureKind } : callResult,
          });
        } catch (error) {
          throw formatToolSearchControlError(error, runtime, toolCallId, signal ?? ctx.abortSignal);
        }
      },
    },
  ].map((tool) => {
    bindGatewayToolPolicyControl(tool);
    return tool.name === TOOL_CALL_RAW_TOOL_NAME
      ? bindAgentToolReplaySafety(tool, "dispatcher")
      : tool;
  });
}
