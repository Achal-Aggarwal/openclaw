# Node surface and transcript maintenance attribution

## Acceptance rule

Before changing production code, run the committed `pairing-live-measure.mts`
workload on current main with one synthetic paired node and the synthetic iMessage
bridge. Keep cold startup separate from its 130-second warm window. Use the frozen
SQL observer for statements, worker requests, and Gateway main-thread statements;
capture CPU profiles for the Gateway and its threads. Report per-minute rates.

For each node-surface UPDATE, compare the bound JSON bytes with the row already
returned to the writer. Record equality and changed field names only, never rows or
bindings. Distinguish unchanged bins/host consent from fresh host-stat samples.
Compare the revision returned by its UPSERT with the revision in that same input
snapshot. A real surface change must still persist and publish its revision.

Attribute every transcript-publication busy-timeout set/restore to its connection
and command. If this pattern is absent, run the existing session-polling workload
with synthetic sessions and worktree bindings. Absence remains an attribution gap,
not evidence that changing the connection policy is safe.

Initial runs are counts and CPU-profile attribution only, with no timing claim.
No production edits precede the design decision. For an approved candidate, count
at least three alternating main/candidate pairs when host conditions allow, or one
pair with the campaign's loaded-host fallback explicitly recorded. The touched
operations must lose statements without adding requests or runtime MAIN work;
warm turns must not regress. A latency claim requires five interleaved samples per
arm on the same platform, cold/warm separated, the timing lock, load below 24, and
median/p95/spread. A 20% regression in any user-facing cell stops the change.

The shared canonical agent connection must retain bounded contention handling for
unrelated writes. No new connection, cache, schema, generation, or retry mechanism
is part of this investigation.
