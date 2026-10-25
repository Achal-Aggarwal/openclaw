import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { t } from "../i18n/index.ts";
import { presenceMatchesProfile, projectPresencePayload } from "../lib/presence-users.ts";
import type { SessionCreatedActor } from "../lib/session-owner.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { sessionAttentionGlyph } from "./session-attention-presentation.ts";

export function sidebarSessionOwner(host: SessionListHost, row: SidebarRecentSession) {
  const attribution: "created" | "owned" | "archived" =
    host.sessionsStatusFilter === "archived"
      ? "archived"
      : row.owner?.assignedAt !== undefined
        ? "owned"
        : "created";
  const owner = host.sessionOwnershipVisibility.avatars
    ? attribution === "archived"
      ? row.archivedBy
      : row.owner?.actor
    : undefined;
  const identity = owner?.identity;
  const ownerViewing =
    identity?.type === "profile"
      ? projectPresencePayload(host.sessionData.presencePayload).users.some(
          (user) =>
            presenceMatchesProfile(user, identity) && user.watchedSessions.includes(row.key),
        )
      : undefined;
  const self = host.sessionDataContext?.gateway.snapshot.selfUser;
  const repeatedByFilter =
    attribution !== "archived" &&
    identity?.type === "profile" &&
    identity.id === (self?.identity?.id ?? self?.id) &&
    (host.sessionInvolvingMeFilterActive || host.sessionOwnerFilterId === owner?.id) &&
    (row.participantCount ?? row.participants?.length ?? 0) === 0;
  const repeatedBySection =
    host.sidebarAgentsMode !== "roster" &&
    host.sessionsGrouping === "person" &&
    !row.pinned &&
    attribution !== "archived" &&
    ownerViewing !== true;
  return {
    owner: repeatedByFilter || repeatedBySection ? undefined : owner,
    attribution,
    ownerViewing,
  };
}

export function describeSessionState(session: SidebarRecentSession) {
  return [
    !session.isChild && session.forkSource ? t("sessionsView.forkedSession") : "",
    (session.hasActiveRun || session.runningChildCount > 0) && session.unread
      ? t("sessionsView.unread")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function summarizeTeamSessionSlots(
  rows: readonly SidebarRecentSession[],
  includeChildren: boolean,
) {
  const attention = summarizeSidebarSessionAttention(
    rows.flatMap((row) =>
      includeChildren
        ? [row.attention]
        : [
            row.ownAttention ?? row.attention,
            ...(row.subagentSummary ? [row.subagentSummary.attention] : []),
          ],
    ),
  );
  let active = 0;
  let queued = 0;
  let unread = 0;
  let failed = false;
  for (const row of rows) {
    const children = includeChildren ? row : row.subagentSummary;
    const visuallyActive = row.isRunVisuallyActive ?? row.hasActiveRun;
    active += Number(visuallyActive) + (children?.runningChildCount ?? 0);
    queued += Number(visuallyActive && row.status === "queued") + (children?.queuedChildCount ?? 0);
    unread += Number(row.unread) + (children?.unreadChildCount ?? 0);
    failed ||=
      row.status === "failed" || row.status === "timeout" || (children?.failedChildCount ?? 0) > 0;
  }
  return {
    attention,
    slots: (rows.length === 1 && rows[0]?.snapshot?.team) || {
      glyph: sessionAttentionGlyph(attention),
      run: active ? (active === queued ? ("queued" as const) : ("active" as const)) : undefined,
      unread: unread || undefined,
      failed: failed || undefined,
    },
  };
}

export function sessionLeadingState(
  session: SidebarRecentSession,
  owner: SessionCreatedActor | null | undefined,
  trailing = false,
  overrideIcon = false,
) {
  const cached = session.snapshot;
  const own = session.isRunVisuallyActive ?? session.hasActiveRun;
  const children = !trailing && session.runningChildCount > 0;
  const run = cached
    ? cached.run
    : children && (!own || session.status === "queued")
      ? "subagents"
      : own
        ? session.status === "queued"
          ? "queued"
          : "active"
        : undefined;
  const glyph = cached ? cached.glyph : sessionAttentionGlyph(session.attention);
  const attention = Boolean(glyph) && !trailing;
  const hasIcon = attention || overrideIcon || Boolean(session.icon);
  const child = session.isChild && !trailing;
  const hasOwner = cached ? Boolean(cached.ownerGlyph) : !child && Boolean(owner?.id?.trim());
  const channel = Boolean(session.channelAvatarUrl);
  const participants = session.participantCount ?? session.participants?.length ?? 0;
  const ring =
    cached?.ownerGlyph ??
    (!hasIcon && !channel && hasOwner && participants > 0 ? "pair" : "circle");
  const running = Boolean(run && !trailing && glyph?.[0] !== "question");
  return {
    run,
    glyph,
    ownerGlyph: !hasIcon && !channel && hasOwner ? ring : undefined,
    attention,
    hasOwner,
    hasContent: hasIcon || channel || hasOwner,
    visible: hasIcon || (child && !channel ? Boolean(run) : channel || hasOwner || running),
    running,
    queued: run === "queued",
    circular: !hasIcon && (channel || hasOwner),
    ring,
    unreadBadge: session.unread && !run && !trailing && !(!hasIcon && child && !channel),
    identities:
      hasIcon || channel || !hasOwner
        ? []
        : [
            owner?.identity,
            participants === 1 ? session.participants?.[0]?.identity : undefined,
          ].filter((identity): identity is SessionParticipantIdentity => identity !== undefined),
  };
}
