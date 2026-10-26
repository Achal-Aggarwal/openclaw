import type {
  FsListDirResult,
  ProjectsRegisterResult,
  ProjectsSearchRemoteResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type {
  DraftPlaceBrowserCallbacks,
  DraftPlaceBrowserSnapshot,
  DraftProjectPickerOwner,
} from "./draft-place-browser.types.ts";
import { isAbsolutePath } from "./path.ts";
import { PICKER_INPUT_DEBOUNCE_MS, PlaceBrowserState } from "./place-browser-state.ts";
import { projectCloneInput } from "./project-chip.ts";

type ProjectSearchOutcome = { result: ProjectsSearchRemoteResult } | { error: unknown } | null;

type ProjectSearchRead = Readonly<{
  query: string;
  completed: Promise<ProjectSearchOutcome>;
}>;

export type BrowserProjectRegistration = Readonly<{
  retired: Promise<void>;
  isCurrent: () => boolean;
}>;

// Loaded with ProjectPickerContent; selection and the shared catalog stay in the draft owner.
export class DraftProjectPicker {
  private projectQueryValue = "";
  private debouncedProjectQuery = "";
  private browserOpenValue = false;
  // Empty lists the Gateway host; otherwise the paired device whose folders are listed.
  private browserNodeIdValue = "";
  private browserProjectPathValue: string | null = null;
  private browserRegistration: {
    retire: () => void;
    client: GatewayBrowserClient;
    epoch: number;
  } | null = null;
  private projectSearchTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  private browserValue: PlaceBrowserState | undefined;

  private projectSearchArgs: readonly unknown[] = [];
  private projectSearchReadValue: ProjectSearchRead | null = null;
  private finishProjectSearch: ((outcome: ProjectSearchOutcome) => void) | undefined;
  private readonly projectSearchRequest = createPageRequest(() => this.callbacks.changed(), {
    task: ([client, query]: readonly [GatewayBrowserClient, string], { signal }) =>
      client.request<ProjectsSearchRemoteResult>("projects.searchRemote", { query }, { signal }),
    onComplete: (result) => {
      this.finishProjectSearch?.({ result });
      this.finishProjectSearch = undefined;
    },
    onError: (error) => {
      this.finishProjectSearch?.({ error });
      this.finishProjectSearch = undefined;
    },
  });

  constructor(
    private readonly gateway: DraftGatewayState,
    private readonly read: () => DraftPlaceBrowserSnapshot,
    private readonly callbacks: DraftPlaceBrowserCallbacks,
    private readonly owner: DraftProjectPickerOwner,
  ) {}

  get browser(): PlaceBrowserState {
    return (this.browserValue ??= new PlaceBrowserState(
      (path) => {
        const snapshot = this.read().context?.gateway.snapshot;
        if (snapshot?.phase !== "connected" || !snapshot.client || !this.browserOpenValue) {
          return Promise.reject(new Error("Folder browser is unavailable"));
        }
        return snapshot.client.request<FsListDirResult>("fs.listDir", {
          ...(this.browserNodeIdValue ? { nodeId: this.browserNodeIdValue } : {}),
          ...(path ? { path } : {}),
        });
      },
      this.callbacks.changed,
      (listing) => {
        this.browserProjectPathValue = null;
        if (this.browserNodeIdValue) {
          // Gateway folder approval and project registration apply only to Gateway paths.
          return;
        }
        this.callbacks.onApprovedListing(listing);
        const snapshot = this.read();
        const client = snapshot.context?.gateway.snapshot.client;
        if (!snapshot.isAdmin || !client) {
          return;
        }
        void client
          .request<WorktreesBranchesResult>("worktrees.branches", {
            repoRoot: listing.path,
            includeRepositoryStatus: true,
          })
          .then((branches) => {
            // Typing keeps this listing valid; replacement or reset retires its probe.
            if (this.browserValue?.listing === listing && branches.repositoryStatus === "git") {
              this.browserProjectPathValue = listing.path;
              this.callbacks.changed();
            }
          })
          .catch(() => undefined);
      },
    ));
  }

  retireDisconnectedRegistration() {
    const registration = this.browserRegistration;
    if (
      registration &&
      (!this.gateway.connected ||
        registration.client !== this.gateway.client ||
        registration.epoch !== this.gateway.connectionEpoch)
    ) {
      this.retireRegistration();
    }
  }

  synchronizeSearch() {
    const args = this.projectSearchInput();
    if (!args.every((arg, index) => Object.is(arg, this.projectSearchArgs[index]))) {
      this.searchProjects(args);
    }
  }

  private projectSearchInput() {
    return [
      this.read().context && this.gateway.connected ? this.gateway.client : null,
      canCallGatewayMethod(
        this.read().context?.gateway.snapshot,
        "projects.searchRemote",
        "operator.read",
      ),
      this.debouncedProjectQuery,
      this.gateway.connectionEpoch,
    ] as const;
  }

  private searchProjects(args = this.projectSearchInput()) {
    this.projectSearchArgs = args;
    this.projectSearchRequest.cancel();
    // A cancelled transport may never settle; retire its presentation immediately.
    this.finishProjectSearch?.(null);
    this.finishProjectSearch = undefined;
    this.projectSearchReadValue = null;
    const [client, advertised, query] = args;
    if (!client || !advertised || query.length < 2 || projectCloneInput(query)) {
      return;
    }
    const completion = Promise.withResolvers<ProjectSearchOutcome>();
    this.projectSearchReadValue = { query, completed: completion.promise };
    this.finishProjectSearch = completion.resolve;
    void this.projectSearchRequest.run([client, query]);
  }

  get projectQuery(): string {
    return this.projectQueryValue;
  }

  get projectSearchRead(): ProjectSearchRead | null {
    return this.projectSearchReadValue?.query === this.projectQueryValue.trim()
      ? this.projectSearchReadValue
      : null;
  }

  get browserOpen(): boolean {
    return this.browserOpenValue;
  }

  get browserNodeId(): string {
    return this.browserNodeIdValue;
  }

  get browserProjectPath(): string | null {
    // The register affordance and fence follow the draft's directory, not just loading state.
    // A shown error (failed navigate or failed registration) leaves the loaded folder valid,
    // so the action stays available for a retry.
    return !this.browserValue ||
      this.browserValue.loading ||
      !this.browserValue.draftInLoadedDirectory()
      ? null
      : this.browserProjectPathValue;
  }

  get browserRegistering(): boolean {
    return this.browserRegistration !== null;
  }

  changeProjectQuery(query: string) {
    this.projectQueryValue = query;
    this.clearProjectSearchTimer();
    this.debouncedProjectQuery = "";
    this.searchProjects([null, false, "", this.gateway.connectionEpoch]);
    const normalized = query.trim();
    const context = this.read().context;
    if (
      normalized.length < 2 ||
      projectCloneInput(normalized) ||
      !this.gateway.connected ||
      !this.gateway.client ||
      !context ||
      !canCallGatewayMethod(context.gateway.snapshot, "projects.searchRemote", "operator.read")
    ) {
      this.callbacks.changed();
      return;
    }
    const client = this.gateway.client;
    const connectionEpoch = this.gateway.connectionEpoch;
    this.projectSearchTimer = globalThis.setTimeout(() => {
      this.projectSearchTimer = undefined;
      if (client !== this.gateway.client || connectionEpoch !== this.gateway.connectionEpoch) {
        return;
      }
      this.debouncedProjectQuery = normalized;
      this.searchProjects([client, true, normalized, connectionEpoch]);
      this.callbacks.changed();
    }, PICKER_INPUT_DEBOUNCE_MS);
    this.callbacks.changed();
  }

  resetProjectSearch() {
    this.clearProjectSearchTimer();
    this.projectQueryValue = "";
    this.debouncedProjectQuery = "";
    this.callbacks.changed();
  }

  selectGatewayBrowser(path?: string) {
    this.openBrowser("", path);
  }

  selectDeviceBrowser(nodeId: string, path?: string) {
    this.openBrowser(nodeId, path);
  }

  private openBrowser(nodeId: string, path?: string) {
    this.browserOpenValue = true;
    this.browserNodeIdValue = nodeId;
    this.browserProjectPathValue = null;
    void this.browser.navigate(path && isAbsolutePath(path) ? path : undefined, "initial");
    this.owner.focusProjectView("path");
  }

  async registerBrowserProject(
    path: string,
    onStarted?: (registration: BrowserProjectRegistration) => void,
  ) {
    const snapshot = this.read();
    const gatewaySnapshot = snapshot.context?.gateway.snapshot;
    const client = gatewaySnapshot?.client;
    if (
      gatewaySnapshot?.phase !== "connected" ||
      !client ||
      !snapshot.isAdmin ||
      this.browserProjectPath !== path ||
      this.browserRegistering
    ) {
      return;
    }
    const listing = this.browser.listing;
    const retirement = Promise.withResolvers<void>();
    const epoch = this.gateway.connectionEpoch;
    const operation = { retire: retirement.resolve, client, epoch };
    this.browserRegistration = operation;
    const isCurrentBrowser = () =>
      this.gateway.connected &&
      this.browser.listing === listing &&
      this.browserProjectPath === path &&
      client === this.gateway.client &&
      epoch === this.gateway.connectionEpoch;
    const isCurrentRegistration = () =>
      this.browserRegistration === operation && isCurrentBrowser();
    this.browser.error = null;
    // Retire the preceding directory error without hiding reads started during registration.
    this.browser.readCompletion = null;
    this.callbacks.changed();
    onStarted?.({ retired: retirement.promise, isCurrent: isCurrentBrowser });
    try {
      const project = await client.request<ProjectsRegisterResult>("projects.register", { path });
      if (!isCurrentRegistration()) {
        return;
      }
      await this.owner.refreshProjects(true);
      if (!isCurrentRegistration()) {
        return;
      }
      this.callbacks.onSelectProject(project.id);
      this.owner.close();
    } catch (error) {
      if (isCurrentRegistration()) {
        this.browser.error = formatUiError(error);
      }
    } finally {
      if (this.browserRegistration === operation) {
        this.browserRegistration = null;
        this.callbacks.changed();
      }
    }
  }

  resetBrowser() {
    this.browserValue?.reset();
    this.browserOpenValue = false;
    this.browserNodeIdValue = "";
    this.browserProjectPathValue = null;
    this.retireRegistration();
  }

  disconnect() {
    this.browserValue?.reset();
    this.retireRegistration();
    this.clearProjectSearchTimer();
    this.searchProjects([null, false, "", -1]);
  }

  private retireRegistration() {
    this.browserRegistration?.retire();
    this.browserRegistration = null;
  }

  private clearProjectSearchTimer() {
    globalThis.clearTimeout(this.projectSearchTimer);
    this.projectSearchTimer = undefined;
  }
}
