import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import { findCapabilityProviderById } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { MEDIA_CAPABILITY_DEFAULTS } from "../../media-understanding/defaults.constants.js";
import {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import { matchesImageEntryCapability } from "../../media-understanding/entry-capabilities.js";
import {
  describeImageWithModel,
  describeImagesWithModel,
} from "../../media-understanding/image-runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import { resolveTimeoutMs } from "../../media-understanding/resolve.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type { ImageCompressionPolicy } from "../../media/web-media.js";
import { resolvePluginCapabilityProvider } from "../../plugins/capability-provider-runtime.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { bindOperatorModelExecution } from "../admitted-run-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import { runWithImageModelFallback } from "../model-fallback-image.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type { AgentToolResult } from "../runtime/index.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { optionalFiniteNumberSchema, optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { readPositiveIntegerParam, type AnyAgentTool } from "./common.js";
import {
  coerceImageModelConfig,
  decodeDataUrl,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import {
  prepareImageCompressionPolicy,
  resolveImageModelConfigForOverride,
} from "./image-tool.model-execution.js";
import {
  buildMediaReferenceDetails,
  buildTextToolResult,
  normalizeMediaReferenceList,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolSandboxConfig,
  resolveMediaToolInboundRoots,
  resolveMediaToolReferenceAccess,
  resolveMediaAnalysisParams,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  applyAgentDefaultModelConfig,
  buildToolModelConfigFromCandidates,
  hasToolModelConfig,
  prepareToolAuthProfileStore,
  resolveDefaultModelRef,
  resolveOpenAiImageMediaCandidate,
} from "./model-config.helpers.js";
import { textResult } from "./tool-results.js";

const DEFAULT_PROMPT = "Describe the image.";
const DEFAULT_MAX_IMAGES = 20;

const ImageToolSchema = Type.Object({
  prompt: Type.Optional(Type.String()),
  path: Type.Optional(Type.String({ description: "One local image path or permitted URL." })),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Local image paths or permitted URLs; maxImages default 20.",
    }),
  ),
  model: Type.Optional(Type.String()),
  maxBytesMb: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
  maxImages: optionalPositiveIntegerSchema(),
});
const NativeVisionImageToolSchema = Type.Omit(ImageToolSchema, ["model"]);

type LoadedImageForTool = {
  buffer: Buffer;
  mimeType: string;
  resolvedInput: string;
  rewrittenFrom?: string;
};

function modelRefProvider(candidate: string | null | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed?.includes("/")) {
    return undefined;
  }
  return trimmed.slice(0, trimmed.indexOf("/")).trim();
}

function isExecutionAliasCandidateForProvider(
  candidate: string | null | undefined,
  provider: string,
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  return Boolean(
    candidateProvider &&
    candidateProvider !== normalizeMediaProviderId(candidateProvider) &&
    normalizeMediaProviderId(candidateProvider) === normalizeMediaProviderId(provider),
  );
}

function resolveImageModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): ImageModelConfig | null {
  // Native-vision runs route post-prompt image bytes to the active model, not fallback config.
  const explicit = coerceImageModelConfig(params.cfg);
  if (hasToolModelConfig(explicit)) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicit,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);
  let verifiedSubstituteProvider: string | undefined;
  const resolveCodexMediaRoute = () => {
    const preparedProviders =
      params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
    const provider = preparedProviders
      ? findCapabilityProviderById({
          providers: preparedProviders,
          providerId: "codex",
          normalizeProviderId: normalizeMediaProviderId,
        })
      : resolvePluginCapabilityProvider({
          key: "mediaUnderstandingProviders",
          providerId: "codex",
          cfg: params.cfg,
        });
    if (!provider?.capabilities?.includes("image")) {
      return undefined;
    }
    const model = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: "codex",
      capability: "image",
      providerRegistry: new Map([[provider.id, provider]]),
      includeConfiguredImageModels: false,
    });
    return model ? { model } : undefined;
  };
  const resolveImplicitOpenAiImageCandidate = (openAiModel: string): string | null => {
    const decision = resolveOpenAiImageMediaCandidate({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      openAiModel,
      resolveCodexMediaRoute,
    });
    if (decision.kind === "substitute") {
      verifiedSubstituteProvider = decision.provider;
      return decision.ref;
    }
    return decision.kind === "keep" ? decision.ref : null;
  };

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const primaryModelId = providerVisionFromConfig
    ? providerVisionFromConfig.slice(providerVisionFromConfig.indexOf("/") + 1)
    : resolveDefaultMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId: primary.provider,
        capability: "image",
        includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider),
      });
  const primaryCandidates =
    providerVisionFromConfig || primaryModelId
      ? [
          primary.provider === "openai"
            ? resolveImplicitOpenAiImageCandidate(primaryModelId ?? "")
            : (providerVisionFromConfig ?? `${primary.provider}/${primaryModelId}`),
        ]
      : isMinimaxVlmProvider(primary.provider)
        ? [`${primary.provider}/MiniMax-VL-01`]
        : [];

  const rawAutoCandidates = resolveAutoMediaKeyProviders({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    capability: "image",
  }).map((providerId) => {
    const modelId = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      capability: "image",
      includeConfiguredImageModels: !isMinimaxVlmProvider(providerId),
    });
    if (!modelId) {
      return null;
    }
    return providerId === "openai"
      ? resolveImplicitOpenAiImageCandidate(modelId)
      : `${providerId}/${modelId}`;
  });
  const allCandidates = [...primaryCandidates, ...rawAutoCandidates];
  const autoCandidates = rawAutoCandidates.filter((candidate) => {
    const provider = modelRefProvider(candidate);
    return (
      !provider ||
      provider !== normalizeMediaProviderId(provider) ||
      !isMinimaxVlmProvider(provider) ||
      !allCandidates.some((other) => isExecutionAliasCandidateForProvider(other, provider))
    );
  });
  const defaultPrimaryIsImplicit = !resolveAgentModelPrimaryValue(
    params.cfg?.agents?.defaults?.model,
  );
  const primaryAliasCandidates = defaultPrimaryIsImplicit
    ? autoCandidates.filter((candidate) =>
        isExecutionAliasCandidateForProvider(candidate, primary.provider),
      )
    : [];
  const remainingAutoCandidates =
    primaryAliasCandidates.length === 0
      ? autoCandidates
      : autoCandidates.filter((candidate) => !primaryAliasCandidates.includes(candidate));

  return buildToolModelConfigFromCandidates({
    explicit,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    candidates: [...primaryAliasCandidates, ...primaryCandidates, ...remainingAutoCandidates],
    isProviderConfigured: (provider) =>
      verifiedSubstituteProvider && provider === verifiedSubstituteProvider ? true : undefined,
  });
}

export function createImageTool(options?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  agentChannel?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  const modelHasVision = options?.modelHasVision === true;
  const explicit = coerceImageModelConfig(options?.config);
  if (!agentDir) {
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const explicitImageModelConfig =
    !modelHasVision && hasToolModelConfig(explicit)
      ? resolveConfiguredImageModelRefs({
          cfg: options?.config,
          imageModelConfig: explicit,
        })
      : null;
  const remoteMediaSsrfPolicy = options?.config?.tools?.web?.fetch?.ssrfPolicy;

  const description = modelHasVision
    ? "Load image(s) into private model context for inspection: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user. Prompt images are already visible."
    : explicitImageModelConfig
      ? "Inspect image(s) in private model context with the configured model: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user."
      : "Inspect image(s) in private model context with available vision: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user.";

  return {
    label: "View Image",
    name: "view_image",
    description,
    ...(modelHasVision ? { catalogMode: "direct-only" as const } : {}),
    parameters: modelHasVision ? NativeVisionImageToolSchema : ImageToolSchema,
    execute: async (_toolCallId, args, suppliedSignal) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        const record = asRecord(args);
        const capturedOperator = await captureAmbientGatewayOperatorAuthority({
          missingBindingError: () =>
            new Error("Image analysis requires its current Gateway binding."),
          retainInherited: true,
        });
        if (capturedOperator.release) {
          onAcquired({ release: capturedOperator.release });
        }
        const operatorAuthority = capturedOperator.authority;
        const signal = operatorAuthority?.signal
          ? suppliedSignal
            ? AbortSignal.any([suppliedSignal, operatorAuthority.signal])
            : operatorAuthority.signal
          : suppliedSignal;
        const assertCurrent = () => {
          capturedOperator.assertInvocationCurrent?.();
          operatorAuthority?.assertCurrent();
          signal?.throwIfAborted();
        };
        assertCurrent();
        const pathInputs = normalizeMediaReferenceList([
          ...(typeof record.path === "string" ? [record.path] : []),
          ...filterStringEntries(record.paths),
        ]);
        if (pathInputs.length === 0) {
          throw new Error("path required");
        }

        const maxImages = readPositiveIntegerParam(record, "maxImages") ?? DEFAULT_MAX_IMAGES;
        if (pathInputs.length > maxImages) {
          return textResult(
            `Too many images: ${pathInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`,
            { error: "too_many_images", count: pathInputs.length, max: maxImages },
          );
        }

        const {
          prompt: promptRaw,
          modelOverride,
          maxBytesMb,
        } = resolveMediaAnalysisParams(record, DEFAULT_PROMPT);
        const maxBytesMbLimit =
          maxBytesMb ?? asPositiveFiniteNumber(options?.config?.agents?.defaults?.mediaMaxMb);
        const maxBytes =
          maxBytesMbLimit === undefined ? undefined : Math.floor(maxBytesMbLimit * 1024 * 1024);
        let imageRoute:
          | { kind: "native" }
          | {
              kind: "fallback";
              imageModelConfig: ImageModelConfig;
              imageCompression: ImageCompressionPolicy;
            };
        if (modelHasVision) {
          imageRoute = { kind: "native" };
        } else {
          let imageModelConfig =
            explicitImageModelConfig ??
            resolveImageModelConfigForOverride({
              cfg: options?.config,
              modelOverride,
            });
          if (!imageModelConfig) {
            const authStore = await prepareToolAuthProfileStore(options);
            assertCurrent();
            imageModelConfig = resolveImageModelConfigForTool({
              cfg: options?.config,
              agentDir,
              workspaceDir: options?.workspaceDir,
              authStore,
              preparedModelRuntime: options?.preparedModelRuntime,
            });
          }
          if (!imageModelConfig) {
            throw new Error(
              "No image model is configured. Set agents.defaults.imageModel or configure an image-capable provider.",
            );
          }
          const imageCompression = await prepareImageCompressionPolicy({
            abortSignal: signal,
            cfg: options?.config,
            imageModelConfig,
            modelOverride,
            imageCount: pathInputs.length,
            agentDir,
            workspaceDir: options?.workspaceDir,
            preparedModelRuntime: options?.preparedModelRuntime,
            operatorAuthority,
          });
          assertCurrent();
          imageRoute = { kind: "fallback", imageModelConfig, imageCompression };
        }
        const imageCompression =
          imageRoute.kind === "fallback" ? imageRoute.imageCompression : undefined;
        const sandboxConfig = resolveMediaToolSandboxConfig(
          options?.sandbox,
          options?.fsPolicy?.workspaceOnly,
        );

        const loadedImages: LoadedImageForTool[] = [];

        for (const pathRawInput of pathInputs) {
          // Stop before starting the next sequential download/decode when the run
          // was aborted, so a dead run cannot keep pulling up to maxImages remote images.
          signal?.throwIfAborted();
          const imageRaw = pathRawInput.startsWith("@")
            ? pathRawInput.slice(1).trim()
            : pathRawInput;
          const normalizedRef = normalizeMediaReferenceSource(imageRaw);

          // Pseudo-URIs such as image:0 have no registry here; reject them before filesystem access.
          const refInfo = classifyMediaReferenceSource(normalizedRef);
          const { isDataUrl, isHttpUrl } = refInfo;
          if (refInfo.hasUnsupportedScheme) {
            return textResult(
              `Unsupported image reference: ${pathRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
              {
                error: "unsupported_image_reference",
                path: pathRawInput,
              },
            );
          }

          if (sandboxConfig && isHttpUrl) {
            throw new Error("Sandboxed view_image does not allow remote URLs.");
          }

          const {
            resolvedPath,
            localRoots: mediaLocalRoots,
            rewrittenFrom,
          } = await resolveMediaToolReferenceAccess({
            input: normalizedRef,
            isDataUrl,
            workspaceDir: options?.workspaceDir,
            cwd: options?.cwd,
            fsPolicy: options?.fsPolicy,
            sandbox: sandboxConfig,
          });
          const resolvedImage = resolvedPath ?? normalizedRef;
          const mediaInboundRoots = resolveMediaToolInboundRoots({
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
            cfg: options?.config,
            channelId: options?.agentChannel ?? options?.currentChannelId,
            accountId: options?.agentAccountId,
          });
          const imageWebMedia = await import("../../media/web-media.js");
          signal?.throwIfAborted();

          const decoded = isDataUrl ? decodeDataUrl(resolvedImage, { maxBytes }) : undefined;
          const media = decoded
            ? await imageWebMedia.optimizeImageBufferForWebMedia({
                buffer: decoded.buffer,
                contentType: decoded.mimeType,
                maxBytes,
                imageCompression,
              })
            : await imageWebMedia.loadWebMedia(resolvedImage, {
                maxBytes,
                imageCompression,
                ...(sandboxConfig
                  ? {
                      sandboxValidated: true,
                      readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
                    }
                  : {
                      localRoots: mediaLocalRoots,
                      inboundRoots: mediaInboundRoots,
                      ssrfPolicy: remoteMediaSsrfPolicy,
                      ...(isHttpUrl
                        ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS }
                        : {}),
                      // Forward the run abort signal into the fetch layer so an abort
                      // mid-download disconnects the in-flight socket.
                      ...(signal ? { requestInit: { signal } } : {}),
                    }),
              });
          signal?.throwIfAborted();
          if (media.kind !== "image") {
            throw new Error(`Unsupported media type: ${media.kind}`);
          }

          const mimeType = media.contentType ?? "image/png";
          loadedImages.push({
            buffer: media.buffer,
            mimeType,
            resolvedInput: resolvedImage,
            ...(rewrittenFrom ? { rewrittenFrom } : {}),
          });
        }

        if (imageRoute.kind === "native") {
          const content = await sanitizeContentBlocksImages(
            loadedImages.map((image) => ({
              type: "image" as const,
              data: image.buffer.toString("base64"),
              mimeType: image.mimeType,
            })),
            "image:native",
            { ...resolveImageSanitizationLimits(options?.config), verifyDecodability: true },
          );
          // Sanitization replaces rejected image blocks with text at the same position.
          const retainedImages = loadedImages.filter(
            (_, index) => content[index]?.type === "image",
          );
          const result: AgentToolResult<unknown> = {
            content: [
              {
                type: "text",
                text: `Loaded ${retainedImages.length} image${retainedImages.length === 1 ? "" : "s"} into private model context for inspection; not displayed, attached, or sent to the user.`,
              },
              ...content,
            ],
            details: {
              transport: "native",
              ...buildMediaReferenceDetails(retainedImages, "image", { includeEmpty: true }),
              media: { outbound: false },
            },
          };
          signal?.throwIfAborted();
          return result;
        }

        // Do not issue a paid vision-provider call for an already-aborted run.
        signal?.throwIfAborted();
        // Text-only runs delegate image understanding to the configured fallback model.
        const {
          config: cfg,
          agentId,
          authProfileStore: authStore,
          workspaceDir,
          preparedModelRuntime,
        } = options ?? {};
        const toolSignal = signal;
        const assertToolCurrent = assertCurrent;

        const effectiveCfg = applyAgentDefaultModelConfig(
          cfg,
          "imageModel",
          imageRoute.imageModelConfig,
        );
        const providerCfg: OpenClawConfig = effectiveCfg ?? {};
        const preparedProviders =
          preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;

        const imageResult = await runWithImageModelFallback({
          cfg: effectiveCfg,
          manifestPlugins: preparedModelRuntime?.metadataSnapshot,
          modelOverride,
          operatorAuthority,
          abortSignal: toolSignal,
          run: (provider, modelId) =>
            runWithAsyncWorkResources(async (onExecutionAcquired) => {
              const execution = bindOperatorModelExecution(operatorAuthority, {
                provider,
                model: modelId,
              });
              if (execution) {
                onExecutionAcquired({ release: execution.release });
              }
              const executionSignal = execution
                ? toolSignal
                  ? AbortSignal.any([toolSignal, execution.signal])
                  : execution.signal
                : toolSignal;
              const assertExecutionCurrent = () => {
                assertToolCurrent?.();
                executionSignal?.throwIfAborted();
                execution?.assertCurrent();
              };
              assertExecutionCurrent();
              // The fallback candidate owns runtime loading; an unrelated media plugin must not
              // block a selected image provider before its request timeout can start.
              const selectedProvider = preparedProviders
                ? findCapabilityProviderById({
                    providers: preparedProviders,
                    providerId: provider,
                    normalizeProviderId: normalizeMediaProviderId,
                  })
                : resolvePluginCapabilityProvider({
                    key: "mediaUnderstandingProviders",
                    providerId: provider,
                    cfg: providerCfg,
                  });
              const providerRegistry = buildMediaUnderstandingRegistry(
                selectedProvider ? { [provider]: selectedProvider } : undefined,
                providerCfg,
                preparedProviders ?? [],
              );
              const sharedEntry = providerCfg.tools?.media?.models?.find((entry) => {
                const timeoutEntry = { entry, provider, model: modelId, providerRegistry };
                const configuredProvider = normalizeMediaProviderId(
                  timeoutEntry.entry.provider ?? "",
                );
                const normalizedSelectedProvider = normalizeMediaProviderId(timeoutEntry.provider);
                if (
                  !configuredProvider ||
                  configuredProvider !== normalizedSelectedProvider ||
                  !matchesImageEntryCapability(timeoutEntry)
                ) {
                  return false;
                }
                const configuredModel = timeoutEntry.entry.model?.trim();
                if (!configuredModel) {
                  return true;
                }
                const providerPrefix = `${normalizedSelectedProvider}/`;
                const normalizedConfiguredModel = configuredModel.startsWith(providerPrefix)
                  ? configuredModel.slice(providerPrefix.length)
                  : configuredModel;
                return normalizedConfiguredModel === timeoutEntry.model;
              });
              const timeoutMs = resolveTimeoutMs(
                sharedEntry?.timeoutSeconds ?? providerCfg.tools?.media?.image?.timeoutSeconds,
                MEDIA_CAPABILITY_DEFAULTS.image.timeoutSeconds,
              );
              const imageProvider = getMediaUnderstandingProvider(provider, providerRegistry);
              const request = {
                provider,
                model: modelId,
                prompt: promptRaw,
                maxTokens: 4096,
                timeoutMs,
                ...(executionSignal ? { signal: executionSignal } : {}),
                cfg: providerCfg,
                ...(agentId ? { agentId } : {}),
                agentDir,
                authStore,
                ...(workspaceDir ? { workspaceDir } : {}),
                ...(preparedModelRuntime ? { preparedModelRuntime } : {}),
              };
              if (
                loadedImages.length > 1 &&
                (imageProvider?.describeImages || !imageProvider?.describeImage)
              ) {
                const describeImages = imageProvider?.describeImages ?? describeImagesWithModel;
                // A run cancelled mid-dispatch must not buy another provider call.
                assertExecutionCurrent();
                const described = await describeImages({
                  images: loadedImages.map((image, index) => ({
                    buffer: image.buffer,
                    fileName: `image-${index + 1}`,
                    mime: image.mimeType,
                  })),
                  ...request,
                });
                assertExecutionCurrent();
                return { text: described.text, provider, model: described.model ?? modelId };
              }
              const describeImage = imageProvider?.describeImage ?? describeImageWithModel;
              const parts: string[] = [];
              for (const [index, image] of loadedImages.entries()) {
                // A run cancelled mid-dispatch must not buy another provider call.
                assertExecutionCurrent();
                const described = await describeImage({
                  buffer: image.buffer,
                  fileName: `image-${index + 1}`,
                  mime: image.mimeType,
                  ...request,
                  prompt:
                    loadedImages.length === 1
                      ? promptRaw
                      : `${promptRaw}\n\nDescribe image ${index + 1} of ${loadedImages.length}.`,
                });
                assertExecutionCurrent();
                if (loadedImages.length === 1) {
                  return { text: described.text, provider, model: described.model ?? modelId };
                }
                parts.push(`Image ${index + 1}:\n${described.text.trim()}`);
              }
              return {
                text: parts.join("\n\n").trim(),
                provider,
                model: modelId,
              };
            }),
        });

        const result = {
          ...imageResult.result,
          attempts: imageResult.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model,
            error: attempt.error,
          })),
        };

        return buildTextToolResult(result, buildMediaReferenceDetails(loadedImages, "image"));
      }),
  };
}
