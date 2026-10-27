import type { Buffer } from "node:buffer";

export type FixtureAsset = {
  body: string | Buffer;
  contentType: string;
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
};

export type FixtureOptions = {
  baseUrl?: string;
  now?: number;
  /** Supply the real canvas sandbox fixture for browser/widget measurements. */
  sandboxUrl?: string;
  sandboxPort?: number;
  liveRun?: boolean;
  sidebarListChurn?: boolean;
  sidebarLiveChurn?: boolean;
  sidebarAvatars?: boolean;
  transcriptAvatars?: boolean;
  sidebarPresentation?: boolean;
  sidebarPersistentChildren?: boolean;
  sessionEventChurn?: boolean;
  sessionEventDurationMs?: number;
  sessionEventAncestorRefs?: boolean;
  duplicateBootReads?: boolean;
  /** Opt into the canonical core descriptor catalog supplied by the benchmark. */
  coreBoot?: { methods: readonly string[] };
  closedMenuMembers?: boolean;
  largeSnapshot?: boolean;
  rowFacts?: boolean;
  offRosterSession?: boolean;
  transcriptMessages?: number;
  dashboardMcpApp?: { font: Buffer };
  /** Opt into a scripted HTML dashboard with an independently fetched web font. */
  dashboardWidgetFontUrl?: string;
  dashboardPaintMarker?: boolean;
};
