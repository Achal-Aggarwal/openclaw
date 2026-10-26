---
summary: "Manual same-run qualification of a shared private QA runtime for two existing Node worker E2E shards"
title: "Shared runtime pilot"
read_when:
  - You are evaluating shared Node runtime preparation in CI
  - You are interpreting the manual shared-runtime qualification receipts
---

# Shared runtime pilot

The manual **Shared runtime pilot** workflow compares independent preparation
with one same-run runtime artifact. It is an experiment, not a production gate,
a test-result cache, or a replacement for the existing Node shard runner.
There is no automatic push, pull-request, or scheduled trigger.

## Scope and safety

Run `.github/workflows/ci-shared-runtime-pilot.yml` through GitHub Actions'
**Run workflow** control in `openclaw/openclaw` after the workflow source has been
reviewed. Select the canonical branch containing that source; the workflow
checks out its immutable `github.sha` in every job. There are no dispatch inputs,
no arbitrary target ref, and no pull-request checkout. Fork repositories are
excluded by every job's admission condition. GitHub must recognize this workflow
on the default branch before it offers manual dispatch; opening a draft PR does
not register or run it.

The workflow has `contents: read` permission, disables persisted checkout
credentials, uses the repository's existing Node setup action, and pins external
actions to the same immutable revisions as ordinary CI. It does not consume
repository secrets, publish a package, write an Actions dependency cache, enable
a new service, or change production CI. Runtime and measurement artifacts are
limited to this run attempt and retained for one day. They are diagnostic Actions
artifacts, not release packages.

Every job uses `ubuntu-24.04`: the existing GitHub-hosted Ubuntu runner, without
a larger-runner or paid-provider label. Both arms get the same label and pinned
Node version. This is a hosted-runner comparison, not a claim that the nominal
CPU class equals the production 8-class worker lane. Receipts record the actual
available CPU count, memory, and runner image. No larger runner is justified by
a measured need yet. Each matrix allows at most two concurrent rows, jobs have
a 60-minute ceiling, and the workflow's single concurrency group does not cancel
an active experiment. GitHub may replace an older pending dispatch with a newer
one; this group is not a durable FIFO experiment queue.

## What runs

The plan command calls the existing `createNodeWorkerE2eTestShards` owner and
requires its two complete rows. The inventory remains owned by
`scripts/lib/ci-node-worker-e2e-inventory.mts`; the pilot does not copy or narrow
that file list. See [Node test lanes](/ci/scope-and-routing/node-test-lanes).
Both arms consume exactly the same emitted matrix:

| Arm              | Preparation                                                                                                                | Execution                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Control          | Each of two rows installs dependencies and builds its own private QA runtime                                               | Each row runs its unchanged existing shard            |
| Shared producer  | One job installs dependencies, builds the private QA runtime, packs it, and uploads it                                     | No tests; its cost belongs to the shared arm          |
| Shared consumers | Each of two rows independently installs dependencies, downloads the producer's exact artifact ID, and verifies/restores it | Each row runs the same unchanged shard as its control |

Builds use `pnpm build qaRuntime` with `OPENCLAW_BUILD_PRIVATE_QA=1` and
`VITEST=1`. Producer, controls, and consumers inherit the same runtime environment.
Dependencies and `node_modules` are not transported. Setup uses a frozen lockfile
with optional dependency, transform, and compiled-worker caches disabled for
both arms. This intentionally measures fresh preparation, not the current
production warm-cache distribution.

The pack/restore owner is `scripts/ci-node-runtime-artifact.mjs`. The producer
writes `runtime.tgz` and `manifest.json` for the selected source SHA and
`private-qa` build mode. Consumers restore through that same owner with the
expected SHA and mode before any test runs. They do not select an artifact by
an ambiguous name, another workflow run, or a "latest" lookup.

The run command maps the planner row into the existing
`scripts/ci-run-node-test-shard.mts` contract. Test runtime policy stays Node;
private-QA consumers use `OPENCLAW_E2E_USE_PREBUILT_DIST=1`. Existing targets,
configurations, include patterns, environment, serial plan admission, worker
limits, timeouts, and assertions remain owned by the ordinary shard runner.
Restoring build output never counts as executing tests or reusing test results.

## Evidence and timing boundaries

The workflow emits command receipts for each build, pack, restore, and shard
execution, plus five job receipts: two controls, one producer, and two shared
consumers. Names include the arm and original check name; Actions artifact names
also include the run ID and attempt. The report downloads only that attempt's
receipt artifacts and rejects missing jobs, failed/skipped arms, mismatched
source/run identity, missing phase receipts, and failed command receipts.
A partially successful run is not a completed comparison.

Job clocks begin in the first shell step, before checkout. They stop immediately
before receipt upload. They include checkout, toolchain/dependency setup,
preparation, runtime transfer where applicable, and test execution. They exclude
initial runner provisioning/queueing, final receipt upload, and action post-job
cleanup. The setup submeasurement covers checkout through completion of setup.
The producer's transfer submeasurement covers runtime upload; consumers'
transfer submeasurement includes download plus verification and restoration.
The pack/restore commands also have their own phase receipts; overlapping
measurements must not be added twice. `artifactBytes` is the compressed
`runtime.tgz` file size, not total network bytes or storage billing.

The report preserves raw measurements rather than claiming a speedup. Inspect
full Actions step/job timings alongside receipts for queueing, action cleanup,
and receipt-transfer overhead. The plan and report jobs are experiment overhead,
not part of either production proposal. The shared producer is part of the
proposal and must not be omitted.

For each complete same-source run, compare:

- **Runner work:** the sum of both control job durations versus the producer
  plus both shared-consumer job durations, with excluded Actions overhead
  accounted for separately.
- **Completion latency:** the control arm's earliest start to latest finish
  versus the producer's start to the last shared-consumer finish. Consumer-only
  durations hide the dependency barrier and producer queueing.
- **Preparation and transport:** independent build times versus shared build,
  pack, upload, both downloads, and both restores; retain artifact size and
  observed runner resources.
- **Correctness:** selected file identities, test/pass/fail/skip counts, fresh
  execution receipts, and nonzero failure propagation must remain equivalent.
  A green job alone does not establish count parity.

## Decision rule and limits

The first question is whether avoiding one duplicated private-QA build pays for
an additional producer install, archive work, two downloads/restores, and the
new dependency barrier. It may reduce runner work while increasing completion
latency, or lose on both. Keep negative and noisy observations.

Do not promote from one successful dispatch or from build time alone. Require
complete passing runs with unchanged coverage, artifact-integrity negative
controls, and repeated comparable measurements that retain setup and transfer
costs. Compare with the existing production warm-cache profile before changing
production routing. Hosted image drift, network variance, scheduling order,
shared contention, rerun-attempt behavior, and differing CPU observations limit
comparability. Report those conditions; do not invent population percentiles,
whole-CI savings, monthly cost reductions, or Dagger gains from this pilot.

Until such measurements exist, the recommendation is **qualify manually; do
not promote shared preparation into production CI**. This draft provides the
measurement path, not a measured performance result.
