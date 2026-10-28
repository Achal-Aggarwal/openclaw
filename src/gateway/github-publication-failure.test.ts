import { describe, expect, it } from "vitest";
import {
  GitHubPublicationSessionBranchMismatchError,
  GitHubPublicationWorkspaceChangedError,
  gitHubPublicationPushFailure,
  resolveGitHubPublicationFailure,
} from "./github-publication-failure.js";

describe("resolveGitHubPublicationFailure", () => {
  it("names both branches and the repair for a renamed session branch", () => {
    const failure = resolveGitHubPublicationFailure(
      new GitHubPublicationSessionBranchMismatchError({
        session: "openclaw/keen-crayfish",
        checkedOut: "fix/knowledge-scribe-repair",
      }),
    );
    expect(failure).toEqual({
      code: "workspace_changed",
      nextAction:
        "The session worktree has branch fix/knowledge-scribe-repair checked out, but this session publishes branch openclaw/keen-crayfish. " +
        "In the session worktree, rename the branch back with `git branch -m fix/knowledge-scribe-repair openclaw/keen-crayfish`, " +
        "or switch to it with `git switch openclaw/keen-crayfish` if it still exists, then request publication again. " +
        "Publication only pushes the session branch.",
    });
  });

  it("leads known failure guidance with the specific reason", () => {
    expect(
      resolveGitHubPublicationFailure(
        new GitHubPublicationWorkspaceChangedError(
          "GitHub publication workspace authority changed",
        ),
      ).nextAction,
    ).toMatch(
      /^GitHub publication workspace authority changed\. Inspect the reconciled workspace/u,
    );
  });

  it("states a rejected push once", () => {
    const { nextAction } = resolveGitHubPublicationFailure(
      gitHubPublicationPushFailure({ code: 1, signal: null, killed: false }, true, {
        login: "octocat",
        pushRepository: "example/repository",
      }),
    );
    expect(nextAction).toMatch(
      /^GitHub rejected the push to example\/repository\. Nothing was pushed as @octocat\./u,
    );
    expect(nextAction.match(/rejected/gu)).toHaveLength(1);
  });

  it("keeps raw messages from unclassified errors out of the guidance", () => {
    const failure = resolveGitHubPublicationFailure(
      new Error("git push failed: remote: token ghp_secret rejected"),
    );
    expect(failure.code).toBe("push_rejected");
    expect(failure.nextAction).not.toContain("ghp_secret");
  });
});
