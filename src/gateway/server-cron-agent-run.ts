import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { getPluginInstanceCodeIdentity } from "../plugins/plugin-code-identity.js";
import { listRegisteredPluginCommands } from "../plugins/plugin-command-registry.js";
import { executeScheduledPluginCommandDispatch } from "../plugins/plugin-command-runtime.js";
import { getPluginInstanceIncarnation } from "../plugins/plugin-instance-scope.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { runPluginCommandScheduledTurn } from "./plugin-command-scheduled-run.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

/**
 * Agent-job deps of the Gateway cron service: the runner, and the loaded plugin instances the
 * scheduler claim can re-arm restartable command schedules onto.
 */
export function createGatewayCronAgentDeps(params: {
  deps: CliDeps;
  storePath: string;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  resolveGatewayContext?: GatewayContextResolver;
  resolvePluginRegistry?: () => PluginRegistry | undefined;
}): Pick<CronServiceDeps, "runIsolatedAgentJob" | "resolvePluginCommandScheduleHosts"> {
  return {
    // Select the reserved command path before ordinary cron prompt processing.
    runIsolatedAgentJob: async (request) => {
      const { job } = request;
      const { agentId, cfg } = params.resolveCronAgent(job.agentId);
      const pluginCommandResult = await runPluginCommandScheduledTurn({
        request,
        cfg,
        agentId,
        resolveGatewayContext: params.resolveGatewayContext,
        resolvePluginRegistry: params.resolvePluginRegistry,
        executeScheduledDispatch: executeScheduledPluginCommandDispatch,
      });
      if (pluginCommandResult) {
        return pluginCommandResult;
      }
      return await runCronIsolatedAgentTurn({
        ...request,
        cfg,
        deps: params.deps,
        cronStorePath: params.storePath,
        agentId,
        sessionKey: `cron:${job.id}`,
        trigger: "cron",
        lane: "cron",
      });
    },
    // Re-arm candidates only; each occurrence still checks its live owners before dispatch.
    resolvePluginCommandScheduleHosts: () => {
      const registry = params.resolvePluginRegistry?.();
      if (!registry || isPluginRegistryRetired(registry)) {
        return [];
      }
      const commands = listRegisteredPluginCommands(registry);
      return registry.plugins.flatMap((plugin) => {
        const pluginIncarnation = getPluginInstanceIncarnation(plugin);
        if (
          !pluginIncarnation ||
          plugin.status !== "loaded" ||
          !plugin.enabled ||
          !plugin.contracts?.sessionScheduledTurns?.includes("requester-command")
        ) {
          return [];
        }
        // Without a code identity (captured source or the exact loaded build) nothing re-arms onto it.
        const sourceDigest = getPluginInstanceCodeIdentity(plugin);
        if (!sourceDigest) {
          return [];
        }
        return [
          {
            pluginId: plugin.id,
            pluginIncarnation,
            pluginSource: plugin.source,
            pluginRoot: plugin.rootDir,
            pluginVersion: plugin.version,
            sourceDigest,
            commands: commands
              .filter(
                (command) =>
                  command.pluginId === plugin.id &&
                  command.pluginRoot === plugin.rootDir &&
                  command.requireAuth === true &&
                  command.runtimeCapabilities?.includes("subagents"),
              )
              .map((command) => command.name),
          },
        ];
      });
    },
  };
}
