import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ProjectRecord,
  ProjectRecent,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { projectsForGateway, type ProjectCatalog } from "../../lib/projects.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type {
  DraftPlaceBrowserCallbacks,
  DraftPlaceBrowserSnapshot,
  ProjectBrowserFocus,
} from "./draft-place-browser.types.ts";
import type { DraftProjectPicker } from "./draft-project-picker.ts";
import { isKnownWorkspacePath } from "./path.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

type DraftPickerKind = "where" | "project" | "checkout";

type DraftProjectSelection =
  | { kind: "local"; id: string }
  | { kind: "remote"; project: DraftRemoteProject }
  | null;

export class DraftPlaceBrowser {
  readonly projectFocus: ProjectBrowserFocus = {};
  private projectCatalog: ProjectCatalog | undefined;
  private projectCatalogCleanup: (() => void) | undefined;
  private projectCatalogGateway: ApplicationContext["gateway"] | undefined;
  private lastProjectResult: ProjectCatalog["snapshot"]["result"] = null;
  private projectSelection: DraftProjectSelection = null;
  private selectedProjectRecord: ProjectRecord | undefined;
  private environmentQueryValue = "";
  private projectPickerValue: DraftProjectPicker | undefined;
  private openPopoverValue: DraftPickerKind | null = null;
  private focusRequestId = 0;

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly read: () => DraftPlaceBrowserSnapshot,
    private readonly callbacks: DraftPlaceBrowserCallbacks,
  ) {}

  projectPicker(Picker: typeof DraftProjectPicker): DraftProjectPicker {
    return (this.projectPickerValue ??= new Picker(this.gateway, this.read, this.callbacks, this));
  }

  synchronize() {
    this.projectPickerValue?.retireDisconnectedRegistration();
    this.bindProjectCatalog();
    this.projectPickerValue?.synchronizeSearch();
  }

  get projects(): readonly ProjectRecord[] {
    return this.projectCatalog?.snapshot.result?.projects ?? [];
  }

  get projectsReady(): boolean {
    return this.projectCatalog?.snapshot.ready ?? false;
  }

  get projectsLoading(): boolean {
    return this.projectCatalog?.loading ?? false;
  }

  get projectRead(): Promise<void> | null {
    return this.projectCatalog?.pendingRead ?? null;
  }

  get projectRecents(): readonly ProjectRecent[] | undefined {
    return this.projectCatalog?.snapshot.result?.recents;
  }

  resolveProjectRecents(params: {
    sessions: readonly {
      execCwd?: unknown;
      execNode?: unknown;
      worktree?: { repoRoot?: unknown } | null;
    }[];
    workspace: string;
    workspaceRoots: readonly string[];
    isAdmin: boolean;
  }): ProjectRecent[] {
    const allowGatewayFolder = (folder: string) =>
      params.isAdmin || isKnownWorkspacePath(params.workspaceRoots, folder);
    const serverRecents = this.projectRecents?.filter((recent) =>
      recent.kind === "project"
        ? this.projects.some((project) => project.id === recent.projectId)
        : recent.kind === "repository" || (!recent.execNode && allowGatewayFolder(recent.folder)),
    );
    if (serverRecents !== undefined) {
      return serverRecents;
    }
    const folders = new Set<string>();
    for (const row of params.sessions) {
      const folder =
        normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
      const execNode = normalizeOptionalString(row.execNode);
      if (!folder || execNode || folder === params.workspace || !allowGatewayFolder(folder)) {
        continue;
      }
      folders.add(folder);
      if (folders.size >= 4) {
        break;
      }
    }
    return Array.from(folders, (folder): ProjectRecent => ({
      kind: "folder",
      folder,
      displayName: pathDisplayName(folder),
    }));
  }

  get githubHost(): string | undefined {
    return this.projectCatalog?.snapshot.result?.githubHost;
  }

  get defaultRemoteProject(): DraftRemoteProject | null {
    const configured = this.projectCatalog?.snapshot.result?.defaultRepository;
    return configured
      ? {
          identity: configured.identity,
          cloneUrl: configured.url,
          ...(configured.ref ? { defaultBranch: configured.ref } : {}),
        }
      : null;
  }

  get defaultRemoteProjectProfileId(): string {
    return this.projectCatalog?.snapshot.result?.defaultRepository?.profileId ?? "";
  }

  get projectId(): string {
    return this.projectSelection?.kind === "local" ? this.projectSelection.id : "";
  }

  get remoteProject(): DraftRemoteProject | null {
    return this.projectSelection?.kind === "remote" ? this.projectSelection.project : null;
  }

  get browserOpen(): boolean {
    return this.projectPickerValue?.browserOpen ?? false;
  }

  get environmentQuery(): string {
    return this.environmentQueryValue;
  }

  changeEnvironmentQuery(query: string) {
    this.environmentQueryValue = query;
    this.callbacks.changed();
  }

  popoverOpen(kind: DraftPickerKind): boolean {
    return this.openPopoverValue === kind;
  }

  popoverCallbacks(kind: DraftPickerKind) {
    return {
      popoverOpen: this.popoverOpen(kind),
      onPopoverShow: () => this.transitionPopover(kind, true),
      onPopoverHide: () => this.transitionPopover(kind, false),
      onPopoverAfterHide: this.callbacks.changed,
    };
  }

  private bindProjectCatalog() {
    const gateway = this.gateway.connected ? this.read().context?.gateway : undefined;
    if (gateway === this.projectCatalogGateway) {
      return;
    }
    this.projectCatalogCleanup?.();
    this.projectCatalogGateway = gateway;
    this.projectCatalog = gateway ? projectsForGateway(gateway) : undefined;
    this.lastProjectResult = null;
    const update = () => {
      const result = this.projectCatalog?.snapshot.result ?? null;
      if (result && result !== this.lastProjectResult) {
        this.lastProjectResult = result;
        if (this.projectId && !result.projects.some((project) => project.id === this.projectId)) {
          this.callbacks.onProjectMissing();
        }
      }
      this.callbacks.changed();
    };
    // Catalog receipts clear vanished project selections before the next draft read.
    this.projectCatalogCleanup = this.projectCatalog?.subscribe(update);
    update();
  }

  async refreshProjects(invalidate = false): Promise<void> {
    this.bindProjectCatalog();
    await this.projectCatalog?.refresh(invalidate);
  }

  selectedProject(): ProjectRecord | undefined {
    return (
      this.projects.find((project) => project.id === this.projectId) ??
      (this.gateway.connected ? undefined : this.selectedProjectRecord)
    );
  }

  selectProject(selection: Exclude<DraftProjectSelection, null>) {
    this.projectSelection = selection;
    this.selectedProjectRecord = this.projects.find((project) => project.id === this.projectId);
  }

  recordRemoteProjectId(cloneUrl: string, projectId: string) {
    const project = this.remoteProject;
    if (project?.cloneUrl === cloneUrl) {
      this.projectSelection = { kind: "remote", project: { ...project, projectId } };
    }
  }

  clearProjectSelection() {
    this.projectSelection = null;
    this.selectedProjectRecord = undefined;
  }

  resetProjectSearch() {
    if (this.projectPickerValue) {
      this.projectPickerValue.resetProjectSearch();
    } else {
      this.callbacks.changed();
    }
  }

  resetProjects(resetSelection = true) {
    // The shared catalog retires connection/principal results at its owner.
    if (this.projectCatalog) {
      void this.refreshProjects(true);
    }
    if (!resetSelection) {
      return;
    }
    this.clearProjectSelection();
    this.resetProjectSearch();
  }

  close() {
    this.resetBrowser(true);
  }

  showRoot() {
    const wasBrowsing = this.projectPickerValue?.browserOpen;
    this.resetBrowser(false);
    if (wasBrowsing) {
      this.focusProjectView("browse");
    }
  }

  private transitionPopover(kind: DraftPickerKind, showing: boolean) {
    if (showing) {
      this.openPopoverValue = kind;
      if (kind === "where") {
        this.environmentQueryValue = "";
      }
    } else if (this.openPopoverValue === kind) {
      this.openPopoverValue = null;
    }
    if (kind === "project") {
      this.showRoot();
    } else {
      this.callbacks.changed();
    }
  }

  disconnect() {
    this.focusRequestId += 1;
    this.environmentQueryValue = "";
    this.projectPickerValue?.disconnect();
    this.projectCatalogCleanup?.();
    this.projectCatalogCleanup = undefined;
    this.projectCatalogGateway = undefined;
    this.projectCatalog = undefined;
  }

  private resetBrowser(closePopover: boolean) {
    this.focusRequestId += 1;
    this.projectPickerValue?.resetBrowser();
    if (closePopover) {
      this.openPopoverValue = null;
    }
    this.callbacks.changed();
  }

  focusProjectView(kind: keyof ProjectBrowserFocus) {
    const requestId = ++this.focusRequestId;
    const origin = this.callbacks.activeElement();
    void this.callbacks.updateComplete().then(() => {
      if (requestId !== this.focusRequestId || this.openPopoverValue !== "project") {
        return;
      }
      const active = this.callbacks.activeElement();
      const target = this.projectFocus[kind];
      if (
        target?.isConnected &&
        (!active || active === origin || active === active.ownerDocument.body)
      ) {
        target.focus({ preventScroll: true });
      }
    });
  }
}
