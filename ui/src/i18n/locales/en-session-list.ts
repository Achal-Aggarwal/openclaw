import type { TranslationMap } from "../lib/types.ts";
import { registerSessionOrganizationSharedEnglish } from "./en-session-organization-shared.ts";
import { en } from "./en.ts";

// The resident list owns personal groups; management copy waits for its surface.
const catalog = {
  sessionsView: {
    personalGroups: "Personal groups",
    personalGroupNew: "New personal group",
    personalGroupEdit: "Edit personal group",
    personalGroupName: "Group name",
    personalGroupHint: "Only your layout changes. Sessions and shared groups stay unchanged.",
    personalGroupEmpty: "Drag sessions here or choose Edit group to add them.",
    personalGroupSessions: "Sessions",
    personalGroupSearch: "Search available sessions",
    personalGroupNoMatches: "No matching sessions in the loaded list.",
    personalGroupOptions: "Options for personal group {group}",
    personalGroupEditMenu: "Edit group",
    personalGroupMoveUp: "Move up",
    personalGroupMoveDown: "Move down",
    personalGroupRemove: "Remove personal group",
    personalGroupRemoved: "Personal group removed. Sessions are unchanged.",
    personalGroupUnavailable: "Connection changed. Reopen the group to edit it.",
    personalGroupChanged: "This group changed. Reopen it before saving your edits.",
    personalGroupCapacity:
      "Personal groups are full. Remove a group or some sessions before adding more.",
    active: "Updated within",
    all: "All",
    snoozed: "Snoozed",
  },
} satisfies TranslationMap;

export const registerSessionListEnglish = Object.assign(
  () => {
    registerSessionOrganizationSharedEnglish();
    Object.assign(en.sessionsView, catalog.sessionsView);
  },
  { catalog },
);
