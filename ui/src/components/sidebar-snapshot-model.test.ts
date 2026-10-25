import { expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSections,
} from "./sidebar-snapshot-model.ts";
import {
  sidebarSnapshot as model,
  sidebarSnapshotWithRows,
} from "./sidebar-snapshot.test-support.ts";

function captureRoster(rows: Parameters<typeof sessionsResult>[0]) {
  return captureBootRoster({
    result: sessionsResult(rows, 1),
    agentId: "main",
    groups: [],
    groupSettings: [],
    sectionOrder: [],
    loading: false,
    error: null,
  });
}
function displayRow(key: string, label: string, pinned = false) {
  return restoreSnapshotSession(
    model,
    { key, label, pinned, isChild: false, children: [] },
    pinned ? key : "",
  );
}

it("reuses the canonical header without restoring authority", () => {
  const key = "agent:main:work";
  const roster = captureRoster([
    { key, kind: "direct", label: "Canonical title", icon: "monitor" },
  ]);
  const captured = sidebarSnapshotWithRows(
    [{ ...displayRow(key, "Canonical title"), unread: true, icon: "monitor" }],
    () => ({ facts: { run: "queued", glyph: ["approval", "shieldQuestion"] } }),
    roster,
  );
  const encoded = JSON.stringify(captured);
  expect(encoded.match(/Canonical title/gu)).toHaveLength(1);
  expect(encoded.match(/shieldQuestion/gu)).toHaveLength(1);
  const saved = parseSidebarSnapshot(JSON.parse(encoded));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!, saved!.sections[0]!.rows[0]!, key);
  expect(restored).toMatchObject({
    label: "Canonical title",
    icon: "monitor",
    unread: true,
    hasActiveRun: false,
    pinnable: false,
    snapshot: { run: "queued", glyph: ["approval", "shieldQuestion"] },
  });
});

it("does not save attention or counts folded from incognito descendants", () => {
  const child = { ...displayRow("agent:main:incognito-hidden", "Private"), incognito: true };
  const row = {
    ...displayRow("agent:main:public", "Public"),
    attention: {
      kind: "error" as const,
      reason: "Private child failure",
      sourceSessionKey: child.key,
    },
    children: [child],
    unreadChildCount: 3,
    runningChildCount: 1,
  };
  const captured = sidebarSnapshotWithRows([row], (source) => ({
    facts: {
      glyph:
        source.attention.kind === "none" ? undefined : [source.attention.kind, "alertTriangle"],
      team: {
        unread: source.unreadChildCount,
        run: source.runningChildCount ? "active" : undefined,
      },
    },
  }));
  const facts = captured.sections[0]?.rows[0]?.facts;
  expect(facts?.glyph).toBeUndefined();
  expect(facts?.team?.unread).toBeUndefined();
  expect(facts?.team?.run).toBeUndefined();
  expect(JSON.stringify(captured)).not.toMatch(/Private|incognito-hidden/);
});

it("roundtrips hidden-run child queries without retaining incognito parent keys", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const child = displayRow("agent:main:child", "Child");
  const hiddenRun = "agent:main:subagent:review";
  const incognitoRun = "agent:main:subagent:incognito-private";
  const captured = sidebarSnapshotWithRows([
    { ...parent, children: [child], childLoadParentKeys: [parent.key, hiddenRun, incognitoRun] },
  ]);
  expect(captured.sections[0]?.rows[0]?.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  const saved = parseSidebarSnapshot(structuredClone(captured));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!, saved!.sections[0]!.rows[0]!, parent.key);
  expect(restored.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  expect(restored.children.map((row) => row.key)).toEqual([child.key]);
  const legacyParent = { ...captured.sections[0]!.rows[0]!, childLoadParentKeys: undefined };
  expect(
    parseSidebarSnapshot({
      ...captured,
      sections: [{ ...captured.sections[0], rows: [legacyParent] }],
    }),
  ).toBeNull();
  expect(
    parseSidebarSnapshot({
      ...captured,
      sections: [
        {
          ...captured.sections[0],
          rows: [{ key: parent.key, pinned: false, isChild: false, children: [] }],
        },
      ],
    }),
  ).not.toBeNull();
  expect(
    parseSidebarSnapshot({
      ...captured,
      sections: [
        {
          ...captured.sections[0],
          rows: [
            {
              ...legacyParent,
              childLoadParentKeys: [parent.key, incognitoRun],
            },
          ],
        },
      ],
    }),
  ).toBeNull();
});

it("keeps primary routing and header facts in the display snapshot without private or live authority", () => {
  const stable = {
    key: "agent:main:dashboard:cedar",
    kind: "direct" as const,
    displayName: "Cedar",
    boardFace: "dashboard" as const,
    boardPresentation: "expanded" as const,
    workspaceDir: "/synthetic/workspace",
  };
  const liveRow = {
    ...stable,
    sharingRole: "owner" as const,
    hasActiveRun: true,
    activeModel: "stale-model",
  };
  const roster = captureRoster([
    liveRow,
    { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
  ]);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual([stable]);
  expect(JSON.stringify(saved)).not.toMatch(/Private title|sharingRole|hasActiveRun|activeModel/u);
  expect(
    parseSidebarSnapshot({
      ...saved,
      roster: { ...roster, result: sessionsResult([{ ...stable, incognito: true }], 1) },
    }),
  ).toBeNull();
});

it("admits the sidebar after the live roster grows beyond the boot window", () => {
  const sessions = Array.from({ length: 240 }, (_, index) => ({
    key: `agent:main:session-${index}`,
    kind: "direct" as const,
    label: `Session ${index}`,
  }));
  const roster = captureRoster(sessions);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual(sessions.slice(0, 200));
});

it("keeps display data without persisting authority, executable plugins, or watched sessions", () => {
  const plugin = { key: "reports/main", pluginId: "reports", id: "main", label: "Reports" };
  const card = { id: "main", name: "Harbor", mainKey: "agent:main:main" };
  const admitted = parseSidebarSnapshot({
    ...model,
    token: "synthetic-secret",
    footer: { ...model.footer, scopes: ["operator.admin"] },
    plugins: [{ ...plugin, mount() {} }],
    cards: [{ ...card, activeNow: true, lastActiveAt: 99 }],
  });
  expect(admitted?.footer).toEqual(model.footer);
  expect(admitted?.plugins).toEqual([plugin]);
  expect(admitted?.cards).toEqual([card]);
  expect(admitted).not.toHaveProperty("token");
  expect(
    parseSidebarSnapshot({
      ...model,
      onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }],
    }),
  ).toBeNull();
});

it("roundtrips avatar identities and revisions without retaining image payloads", () => {
  const owner = {
    id: "operator",
    identity: { type: "profile", id: "operator" },
    avatarUrl: "/avatars/operator?rev=7",
  };
  const participant = {
    id: "helper",
    identity: { type: "agent", id: "helper" },
    avatarUrl: "/avatars/helper?rev=3",
  };
  const viewer = {
    id: "reviewer",
    identity: { type: "profile", id: "reviewer" },
    avatarUrl: "/avatars/reviewer?rev=9",
  };
  const payload = {
    ...model,
    pinnedSessions: [
      {
        key: "agent:main:thread",
        pinned: true,
        isChild: false,
        children: [],
        facts: {
          owner: { ...owner, imageBytes: [1, 2, 3], dataUrl: "data:image/png;base64,AQID" },
          participants: [participant],
          viewers: [viewer],
          avatarImages: [{ url: owner.avatarUrl, imageBytes: [1, 2, 3] }],
        },
      },
    ],
  };
  const saved = parseSidebarSnapshot(JSON.parse(JSON.stringify(payload)));
  expect(saved?.pinnedSessions[0]?.facts).toEqual({
    owner,
    participants: [participant],
    viewers: [viewer],
  });
  for (const field of ["owner", "participants", "viewers"] as const) {
    const inline = { ...owner, avatarUrl: "data:image/png;base64,AQID" };
    expect(
      parseSidebarSnapshot({
        ...payload,
        pinnedSessions: [
          {
            ...payload.pinnedSessions[0],
            facts: { [field]: field === "owner" ? inline : [inline] },
          },
        ],
      }),
    ).toBeNull();
  }
});

it("excludes incognito roots and descendants and restores no live mutation facts", () => {
  const row = displayRow("agent:main:visible", "Project", true);
  const privateRow = { ...row, key: "agent:main:private", incognito: true };
  const captured = sidebarSnapshotWithRows(
    [
      { ...row, children: [privateRow], sharingRole: "owner", activeRunIds: ["live-run"] },
      privateRow,
    ],
    () => ({ snapshotSubtitle: { subtitle: "Private child approval details" } }),
  );
  expect(captured.sections[0]?.rows).toHaveLength(1);
  expect(captured.sections[0]?.rows[0]?.children).toEqual([]);
  expect(captured.sections[0]?.rows[0]?.snapshotSubtitle).toBeUndefined();
  expect(JSON.stringify(captured)).not.toContain("Private child approval details");
  const restored = restoreSnapshotSession(captured, captured.sections[0]!.rows[0]!, row.key);
  expect(restored).toMatchObject({ visuallyActive: true, pinnable: false });
  expect([restored.sharingRole, restored.activeRunIds]).toEqual([undefined, undefined]);
});

it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
  const visible = displayRow("agent:main:public", "Public");
  const hidden = { ...visible, key: "agent:main:private", incognito: true };
  const counts = {
    totalRowCount: 2,
    visibleRowCount: 2,
    visibleLimit: 10,
    collapsedVisibleRowCount: 2,
    renderHeader: true,
  };
  const sections: Parameters<typeof snapshotSections>[0] = [
    {
      ...counts,
      id: "project:private-path",
      project: { name: "Private project", path: "/private/project" },
      rows: [hidden],
    },
    {
      ...counts,
      id: "person:private-person",
      personOwner: { type: "human", id: "private-person", label: "Private person" },
      rows: [hidden],
    },
    { ...counts, id: "category:shared", category: "Shared", rows: [visible, hidden] },
    {
      ...counts,
      id: "category:empty",
      category: "Empty",
      rows: [],
      totalRowCount: 0,
      visibleRowCount: 0,
      collapsedVisibleRowCount: 0,
    },
  ];
  const captured = snapshotSections(sections, new Set([...sections.map(({ id }) => id), "online"]));
  const admitted = parseSidebarSnapshot({ ...model, ...captured });
  expect(admitted?.sections.map((section) => section.id)).toEqual([
    "category:shared",
    "category:empty",
  ]);
  expect(admitted?.sections[0]).toMatchObject({
    totalRowCount: 1,
    visibleRowCount: 1,
    collapsedVisibleRowCount: 1,
  });
  expect(admitted?.sections[1]?.totalRowCount).toBe(0);
  expect(admitted?.collapsedSections).toEqual(["category:shared", "category:empty", "online"]);
  expect(JSON.stringify(admitted)).not.toContain("private");
});

it("retains independently rendered Pinned collapse state through snapshot serialization", () => {
  const captured = snapshotSections([], new Set(["pinned", "online", "category:gone"]));
  const serialized = JSON.stringify({ ...model, ...captured });
  const saved = parseSidebarSnapshot(JSON.parse(serialized));
  expect(saved?.collapsedSections).toEqual(["pinned", "online"]);
});
