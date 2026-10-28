import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { expectExit, expectPriorCiRefusal } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, describePosix } = createMergeOutcomeFixtureHarness();
const { artifactBuildCandidate } = createPriorCiCandidateFactory(fixture);

describePosix("artifact-build failure with successful primary CI", () => {
  it("admits the optional failed attempt without changing the failed review or pending preparation", () => {
    const f = artifactBuildCandidate();
    const review = readFileSync(join(f.worktree, ".local/review.json"), "utf8");
    const gates = readFileSync(join(f.worktree, ".local/gates.env"), "utf8");
    expectExit(f.verifyPriorCi(f.path), 0);
    expect(readFileSync(join(f.worktree, ".local/review.json"), "utf8")).toBe(review);
    expect(readFileSync(join(f.worktree, ".local/gates.env"), "utf8")).toBe(gates);
    expectExit(f.adminPriorCi(f.path), 0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().comments[0]?.body).toContain(
      "Artifact-build failure with successful primary CI",
    );
    expect(f.state().comments[0]?.body).toContain("/actions/runs/502/attempts/2");
    expect(f.record().priorCiAdmin).toMatchObject({
      runId: 501,
      runAttempt: 2,
      primaryCi: { runId: 502, runAttempt: 2 },
      workflowId: 51,
      checkSuiteId: 10,
      failures: [{ jobId: 601 }],
      gateCheckRunId: 1,
    });
  });

  it.each([
    ["primary failed", "current successful primary"],
    ["primary attempt", "current successful primary"],
    ["primary head", "current successful primary"],
    ["primary PR", "current successful primary"],
    ["primary security", "primary CI gate and security-fast"],
    ["required", "must be optional"],
    ["suite", "exact job, suite, workflow"],
    ["new run", "newer artifact-build workflow run"],
  ])("refuses %s before dispatch", (fault, message) => {
    const f = artifactBuildCandidate();
    const state = f.state();
    state.priorCi.artifactFault = fault;
    f.save(state);
    expectPriorCiRefusal(f, message);
  });

  it.each([
    "required check",
    "optional failure",
    "cancelled job",
    "new attempt",
    "security replay",
    "security replay run",
    "workflow input",
  ])("keeps the existing %s boundary", (fault) => {
    const f = artifactBuildCandidate();
    const state = f.state();
    if (fault === "required check" || fault === "optional failure") {
      state.priorCi.nativeChecks = [
        {
          name: "another-check",
          kind: "check",
          required: fault === "required check",
          state: "failure",
        },
      ];
    } else if (fault === "cancelled job") {
      state.priorCi.jobs![1]!.conclusion = "cancelled";
    } else if (fault === "new attempt") {
      state.priorCi.latestAttempt = 3;
    } else if (fault.startsWith("security replay")) {
      state.priorCi.security.fault =
        fault === "security replay" ? "wrong-ci-attempt" : "wrong-ci-run";
    } else {
      f.evidence.failures[0]!.sourcePaths = ["sibling.txt"];
      writeFileSync(f.path, JSON.stringify(f.evidence));
    }
    f.save(state);
    expectPriorCiRefusal(
      f,
      /other failed|cancellation|newer or running|security enforcement|unchanged workflow/,
    );
  });
});
