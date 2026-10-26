import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ChannelId } from "./channel-id.types.js";

/** Resolves one plugin from the authoritative request-scoped or active registry. */
export function resolveRegisteredChannelPlugin(id: ChannelId) {
  const registry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  return pluginEntry ? pluginEntry.plugin : undefined;
}
