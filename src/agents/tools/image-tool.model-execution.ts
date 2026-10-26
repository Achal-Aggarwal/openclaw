import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageCompressionPolicy } from "../../media/web-media.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { resolveImageCompressionModelPolicy } from "../image-compression-policy.js";
import { resolveAllowedImageFallbackCandidates } from "../model-fallback-image.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { resolveConfiguredImageModelRefs, type ImageModelConfig } from "./image-tool.helpers.js";
import { applyAgentDefaultModelConfig } from "./model-config.helpers.js";

export function resolveImageModelConfigForOverride(params: {
  cfg?: OpenClawConfig;
  modelOverride?: string;
}): ImageModelConfig | null {
  const model = params.modelOverride?.trim();
  if (!model) {
    return null;
  }
  return resolveConfiguredImageModelRefs({
    cfg: params.cfg,
    imageModelConfig: { primary: model },
  });
}

export async function prepareImageCompressionPolicy(params: {
  abortSignal?: AbortSignal;
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
  imageCount: number;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<ImageCompressionPolicy> {
  const overrideConfig = resolveImageModelConfigForOverride(params);
  const configuredImageModelConfig = params.imageModelConfig
    ? resolveConfiguredImageModelRefs({
        cfg: params.cfg,
        imageModelConfig: params.imageModelConfig,
      })
    : null;
  const effectiveImageModelConfig = overrideConfig ?? configuredImageModelConfig;
  const effectiveCfg = effectiveImageModelConfig
    ? applyAgentDefaultModelConfig(params.cfg, "imageModel", effectiveImageModelConfig)
    : params.cfg;
  const modelCandidates = resolveAllowedImageFallbackCandidates({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    operatorAuthority: params.operatorAuthority,
    manifestPlugins: params.preparedModelRuntime?.metadataSnapshot,
  });
  const quality = params.cfg?.agents?.defaults?.imageQuality;
  const models = await Promise.all(
    modelCandidates.map((candidate) =>
      resolveImageCompressionModelPolicy({
        abortSignal: params.abortSignal,
        cfg: params.cfg,
        provider: candidate.provider,
        model: candidate.model,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        preparedModelRuntime: params.preparedModelRuntime,
      }),
    ),
  );
  return {
    imageCount: params.imageCount,
    ...(models.length > 0 ? { models } : {}),
    ...(quality ? { quality } : {}),
  };
}
