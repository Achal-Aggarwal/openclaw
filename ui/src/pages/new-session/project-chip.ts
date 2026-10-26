import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { pathDisplayName } from "../../lib/path-display.ts";

registerNewSessionSetupEnglish();

/** Detects pasted clone URLs; the Gateway remains authoritative for host validation. */
export function projectCloneInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /\s/u.test(trimmed)) {
    return null;
  }
  return /^(?:https:\/\/|ssh:\/\/git@|git@[^:]+:)/iu.test(trimmed) ? trimmed : null;
}

export type DraftRemoteProject = Readonly<{
  identity: string;
  cloneUrl: string;
  defaultBranch?: string;
  projectId?: string;
}>;

export function resolveProjectChip(params: {
  folder: string;
  workspace: string;
  projectId: string;
  selectedRemoteProject: DraftRemoteProject | null;
  projects: readonly ProjectRecord[];
  freshWorkspace?: boolean;
}): Readonly<{
  label: string;
}> {
  const folder = params.folder.trim();
  const selectedProject = params.projects.find((project) => project.id === params.projectId);
  return {
    label: params.freshWorkspace
      ? t("newSession.newWorkspace")
      : selectedProject
        ? selectedProject.displayName
        : params.selectedRemoteProject?.identity
          ? params.selectedRemoteProject.identity
          : folder
            ? pathDisplayName(folder)
            : pathDisplayName(params.workspace) || t("newSession.folderPlaceholder"),
  };
}
