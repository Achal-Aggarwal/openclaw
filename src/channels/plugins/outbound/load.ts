import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";
import { resolveRegisteredChannelPlugin } from "../registry-loader.js";

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  return resolveRegisteredChannelPlugin(id)?.outbound;
}
