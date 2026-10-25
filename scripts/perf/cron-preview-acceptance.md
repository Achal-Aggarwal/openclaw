# Cold cron preview acceptance

The existing synthetic workload is `scripts/bench-delivery-recovery.mts` with
`scripts/perf/delivery-recovery-fixture.ts`, committed at
`63000d731b6074d555dbe1c9c714b50d1d027d4b`. Until that workload reaches main, use
those exact two blobs with current-main production code.

Run an isolated token-WebSocket Gateway with 20 disabled cron jobs in one agent
store. Restart before the cold preview; then collect five warm preview/control
pairs. Verify each job's own destination, 20 jobs, zero sends/model requests,
no SQL errors and clean child exits. The frozen v3.1.4 observer counts SQL,
worker requests and runtime main-thread SQL; profile every Gateway thread.

First reproduce the generation/context family on current main: 100 SQL and
20 requests. If it is absent, stop. The candidate must reduce that family to
at most 5 SQL and 1 request per same-store cohort of up to 64 keys. Runtime
main-thread SQL must remain zero. Warm preview/control must remain zero for
SQL, requests and main-thread SQL. Report whole-flow totals separately.

Use the same platform and workload for alternating baseline/candidate runs.
Follow the campaign's host-load policy for count samples. Timing comparisons
require the campaign timing lock, load below 24, at least five samples per arm,
and cold/warm median, p95 and min–max reported separately. A 20% regression in
any user-facing metric stops the change. Loaded-host counts/profiles carry no
latency claim.

Keep production growth within about 120 net lines and retain one generation
lease owner. Shared-read failure must fall back to independent per-job reads.
Preserve exact-key and logical-agent separation, owner-write freshness,
generation replacement handling and final disclosure checks. No schema or
cache change. PostgreSQL approval for the final head is required before landing.
