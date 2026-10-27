import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import { withMemoryMaintenanceAuthority } from "./memory/maintenance-authority.js";
import { getMemorySearchManager } from "./memory/search-manager.js";

export async function indexMemoryOnGateway(params: {
  cfg: OpenClawConfig;
  agentId: string;
  force: boolean;
  assertCurrent: () => void;
  acquireLocalService?: MemoryCoreAcquireLocalService;
}) {
  return withMemoryMaintenanceAuthority(params.assertCurrent, async () => {
    const { manager, error } = await getMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
      purpose: "cli",
      inspectSources: true,
      acquireLocalService: params.acquireLocalService,
    });
    if (!manager) {
      throw new Error(error ?? "Memory search is disabled.");
    }
    try {
      params.assertCurrent();
      if (!manager.sync) {
        throw new Error("The memory manager does not support indexing.");
      }
      // The Gateway owns the remote workspace binding and the derived index.
      // Reuse the same explicit maintenance operation as the local CLI.
      await manager.sync({ reason: "cli", force: params.force });
      params.assertCurrent();
      return manager.status();
    } finally {
      await manager.close?.();
    }
  });
}
