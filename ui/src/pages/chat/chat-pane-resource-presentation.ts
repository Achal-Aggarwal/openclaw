import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import { markdownSessionPublicOrigin } from "../../components/markdown-session-links.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatLinkFaviconFetcher } from "./link-favicon-loader.ts";

export function chatPaneResourceProps(state: ChatPageHost, context: ApplicationContext) {
  const mediaReadAllowed = state.connected && !state.isRouteSessionPending?.();
  return {
    mediaReadAllowed,
    mediaPolicyEpoch: state.mediaPolicyEpoch,
    connectionEpoch: state.connectionEpoch,
    embedSandboxMode: state.embedSandboxMode,
    allowExternalEmbedUrls: state.allowExternalEmbedUrls,
    fetchLinkFavicon: mediaReadAllowed ? resolveChatLinkFaviconFetcher(state) : undefined,
    assistantAttachmentAuthToken: mediaReadAllowed ? resolveControlUiAuthToken(state) : null,
    resolveArtifactDownload: (
      params: Parameters<typeof resolveArtifactDownloadSource>[1],
      signal?: AbortSignal,
    ) => resolveArtifactDownloadSource(state, params, signal),
    basePath: state.basePath,
    sessionPublicOrigin: markdownSessionPublicOrigin(context),
    resourceBasePath: state.resourceBasePath,
  };
}
