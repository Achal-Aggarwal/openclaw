import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";

export type ProjectBrowserFocus = Partial<Record<"browse" | "path", HTMLElement>>;

export type DraftPlaceBrowserSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  isAdmin: boolean;
}>;

export type DraftPlaceBrowserCallbacks = {
  changed: () => void;
  updateComplete: () => Promise<unknown>;
  onProjectMissing: () => void;
  onSelectProject: (projectId: string) => void;
  onApprovedListing: (listing: FsListDirResult) => void;
  activeElement: () => Element | null;
};

export type DraftProjectPickerOwner = {
  refreshProjects: (invalidate?: boolean) => Promise<void>;
  close: () => void;
  focusProjectView: (kind: keyof ProjectBrowserFocus) => void;
};
