import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  snapshotSessions,
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";

export const sidebarSnapshot: SidebarSnapshotModel = {
  ...sidebarBootSnapshot(null),
  footer: { id: "operator", name: "Riley" },
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};

export function sidebarSnapshotWithRows(
  source: readonly SidebarRecentSession[],
  presentation?: Parameters<typeof snapshotSessions>[1],
  roster?: SidebarSnapshotModel["roster"],
): SidebarSnapshotModel {
  const rows = snapshotSessions(source, presentation, roster);
  const model = parseSidebarSnapshot({
    ...sidebarSnapshot,
    roster: roster ?? null,
    sections: [
      {
        id: "ungrouped",
        rows,
        totalRowCount: rows.length,
        visibleRowCount: rows.length,
        visibleLimit: rows.length,
        collapsedVisibleRowCount: rows.length,
        renderHeader: false,
      },
    ],
  });
  if (!model) throw new Error("Invalid sidebar test snapshot");
  return model;
}
