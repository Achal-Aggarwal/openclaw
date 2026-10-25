import type { SessionGitHubOptionsResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.ts";
import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/schema/system-info.ts";
import type { ControlUiSessionPullRequestSnapshot } from "../../../src/gateway/control-ui-contract.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";

/** Synthetic recovered work makes publication discovery part of the first screen. */
export function createControlUiCoreBootFixture(sessionKey: string, gatewayBootId: string) {
  const branch = { owner: "example", repo: "boot-fixture", branch: "fixture/core-boot" };
  const publication: SessionGitHubOptionsResult = {
    personal: {
      state: "disconnected",
      generation: null,
      account: null,
      accessExpiresAtMs: null,
      refreshState: "not_applicable",
      pending: null,
    },
    shared: { source: "system-configured", accountId: 1, login: "fixture-bot" },
    pendingPersonal: null,
    latestShared: {
      result: {
        status: "published",
        requestId: "00000000-0000-4000-8000-000000000001",
        publisher: { source: "system-configured", accountId: 1, login: "fixture-bot" },
        url: "https://github.com/example/boot-fixture/pull/1",
        repository: "example/boot-fixture",
        branch: branch.branch,
        headCommit: "a".repeat(40),
      },
      confirmation: null,
    },
  };
  const snapshot: ControlUiSessionPullRequestSnapshot = {
    status: "ready",
    pullRequests: [],
    rateLimited: false,
    repository: { owner: branch.owner, repo: branch.repo },
    branch,
  };
  return {
    worktree: {
      id: "core-boot-worktree",
      branch: branch.branch,
      repoRoot: "/synthetic/core-boot-project",
    },
    methodResponses: {
      "update.status": { sentinel: null, updateAvailable: null },
      "presence.activity": { ok: true },
      "talk.config": { config: {} },
      "mcp.app.discover": { servers: [], onboarding: [] },
      "system.info": {
        machineName: "Synthetic Gateway",
        hostname: "gateway.example",
        platform: "darwin",
        release: "0",
        arch: "arm64",
        osLabel: "Synthetic macOS",
        nodeVersion: "v26.12.1",
        pid: 1,
        uptimeMs: 60000,
        cpuCount: 4,
        memoryTotalBytes: 1073741824,
        memoryFreeBytes: 536870912,
      } satisfies SystemInfoResult,
      "sessions.branches.list": { branches: [] },
      "sessions.companion.state": { exchanges: [] },
      "sessions.github.options": publication,
      "session.discussion.info": { state: "none" },
      "sessions.observer.visibility": { ok: true },
      "taskSuggestions.list": { suggestions: [] },
      "session.suggestions.list": { suggestions: [], role: "admin" },
      "mentions.list": { gatewayInstanceId: gatewayBootId, revision: 0, items: [] },
    },
    initScript: `;(() => { const __name = (fn) => fn; (${installCoreBootSubscriptions.toString()})(${JSON.stringify(
      {
        event: CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
        sessionKey,
        snapshot,
      },
    )}); })();`,
  };
}

/** The production subscription acknowledges a replace-set, then pushes per-session facts. */
function installCoreBootSubscriptions(input: {
  event: string;
  sessionKey: string;
  snapshot: ControlUiSessionPullRequestSnapshot;
}) {
  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Core boot fixture requires the mock Gateway");
  }
  gateway.setRequestHandler("sessions.viewers.set", ({ params, respond }) => {
    if (
      typeof params !== "object" ||
      params === null ||
      !("sessionKeys" in params) ||
      !Array.isArray(params.sessionKeys) ||
      !params.sessionKeys.every((key) => typeof key === "string")
    ) {
      throw new Error("Core boot fixture requires string viewer session keys");
    }
    respond({ sessionKeys: [...new Set(params.sessionKeys)] });
  });
  gateway.setRequestHandler(
    "controlUi.sessionPullRequests.subscribe",
    ({ params, respond, emit }) => {
      if (
        typeof params !== "object" ||
        params === null ||
        !("sessionKeys" in params) ||
        !Array.isArray(params.sessionKeys)
      ) {
        throw new Error("Core boot fixture requires a pull-request subscription replace-set");
      }
      const passive = "passiveSessionKeys" in params ? params.passiveSessionKeys : [];
      if (!Array.isArray(passive)) {
        throw new Error("Core boot fixture requires passive session keys to be an array");
      }
      const keys = [...new Set<unknown>([...params.sessionKeys, ...passive])];
      const sessions = Object.fromEntries(
        keys.map((key) => {
          if (typeof key !== "string") {
            throw new Error("Core boot fixture requires string session keys");
          }
          return [
            key,
            key === input.sessionKey
              ? input.snapshot
              : { status: "ready", pullRequests: [], rateLimited: false },
          ];
        }),
      );
      respond({ subscribed: keys.length > 0 });
      if (keys.length > 0) {
        // Both callbacks belong to this request's socket; no timer or retained
        // emitter can publish an obsolete replacement after a reconnect.
        emit(input.event, { sessions });
      }
    },
  );
}
