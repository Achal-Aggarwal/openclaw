import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import type { SidebarSnapshotModel, SidebarSnapshotSession } from "./sidebar-snapshot-data.ts";

export {
  parseSidebarSnapshot,
  type SidebarSnapshotModel,
  type SidebarSnapshotSession,
  type SidebarSnapshotFacts,
} from "./sidebar-snapshot-data.ts";

function containsIncognito(rows: readonly SidebarRecentSession[]): boolean {
  return rows.some(
    (row) => row.incognito || isIncognitoSessionKey(row.key) || containsIncognito(row.children),
  );
}

export function snapshotSessions(
  rows: readonly SidebarRecentSession[],
  presentation?: (row: SidebarRecentSession) => Partial<SidebarSnapshotSession>,
  roster?: SidebarSnapshotModel["roster"],
): SidebarSnapshotSession[] {
  return rows
    .filter((row) => !row.incognito && !isIncognitoSessionKey(row.key))
    .map((row) => {
      const privateChildren = containsIncognito([
        ...row.children,
        ...(row.unreadHiddenRuns ?? []),
        ...(row.subagentSummary?.unreadHiddenRuns ?? []),
      ]);
      // A parent's resolved indicators may summarize omitted private descendants.
      const display = privateChildren ? undefined : presentation?.(row);
      const header = roster?.result.sessions.find((entry) => entry.key === row.key);
      return {
        key: row.key,
        agentId: row.agentId,
        subtitle: row.subtitle,
        icon: row.icon,
        color: row.color,
        category: row.category,
        archived: row.archived,
        boardFace: row.boardFace,
        ...display,
        label:
          header && resolveSessionDisplayName(row.key, header) === row.label
            ? undefined
            : row.label,
        pinned: row.pinned,
        isChild: row.isChild || undefined,
        facts: {
          unread: row.unread || undefined,
          status: row.isChild ? row.status : undefined,
          hasAutomation: row.hasAutomation || undefined,
          ...display?.facts,
        },
        childLoadParentKeys: row.childLoadParentKeys?.filter((key) => !isIncognitoSessionKey(key)),
        children: snapshotSessions(row.children, presentation, roster),
      };
    });
}

export function snapshotSections(
  source: SidebarVisibleSections["sections"],
  collapsedSections: ReadonlySet<string>,
  presentation?: Parameters<typeof snapshotSessions>[1],
  roster?: SidebarSnapshotModel["roster"],
) {
  const sections = source.flatMap((section) => {
    const rows = snapshotSessions(section.rows, presentation, roster);
    if (section.rows.length > 0 && rows.length === 0) {
      return [];
    }
    return [
      {
        ...section,
        rows,
        ...(rows.length !== section.rows.length
          ? {
              totalRowCount: rows.length,
              visibleRowCount: Math.min(section.visibleRowCount, rows.length),
              collapsedVisibleRowCount: Math.min(section.collapsedVisibleRowCount, rows.length),
            }
          : {}),
      },
    ];
  });
  const retained = new Set<string>(sections.map((section) => section.id));
  return {
    sections,
    // Pinned and Online render outside the projected list sections.
    collapsedSections: [...collapsedSections].filter(
      (id) => id === "pinned" || id === "online" || retained.has(id),
    ),
  };
}

export function restoreSnapshotSections(
  model: SidebarSnapshotModel,
  selected: string,
): SidebarVisibleSections {
  const sections = model.sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => restoreSnapshotSession(model, row, selected)),
  }));
  return { sections, visibleRows: sections.flatMap((section) => section.rows) };
}

export function restoreSnapshotSession(
  model: SidebarSnapshotModel,
  row: SidebarSnapshotSession,
  selected: string,
): SidebarRecentSession {
  const facts = row.facts;
  const header = model.roster?.result.sessions.find((entry) => entry.key === row.key);
  const label = row.label ?? resolveSessionDisplayName(row.key, header);
  return {
    ...header,
    ...row,
    key: row.key,
    label,
    renameValue: label,
    agentId: row.agentId ?? resolveUiSessionRowAgentId(row, model.brand.agentId ?? "main"),
    pinned: row.pinned ?? false,
    isChild: row.isChild ?? false,
    snapshot: facts,
    owner: undefined,
    active: row.key === selected,
    visuallyActive: row.key === selected,
    hasActiveRun: false,
    modelSelectionLocked: true,
    pinnable: false,
    cloudWorkerStopAction: null,
    hasAutomation: facts?.hasAutomation ?? false,
    unread: facts?.unread ?? false,
    status: facts?.status,
    attention: { kind: "none" },
    childSessionKeys: row.children.map((child) => child.key),
    childLoadParentKeys: row.childLoadParentKeys ?? [],
    children: row.children.map((child) => restoreSnapshotSession(model, child, selected)),
    loadingChildren: false,
    containsActiveDescendant: false,
    runningChildCount: 0,
    failedChildCount: 0,
  };
}
