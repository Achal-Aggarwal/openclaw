# Plugin-state steady polling attribution

## Acceptance rule (registered before execution)

Use the committed `scripts/perf/plugin-state-polling.mts` workload with an
isolated real Gateway and loopback Reef relay, once with `--messages 0` and once
with `--messages 18`, each with a 60-second steady window. Add a third cell with
`--messages 0 --pending-delivery`: a valid, fresh outbound delivery that is neither
rejected nor overdue. This distinguishes populated delivery scans from the empty
shortcut without requiring an external send. Use the committed
`scripts/perf/crabbox-state-polling.mts` workload with a synthetic version-only
provider and zero workers, with its 120-second steady window after 70 seconds
of settling. Repeat with `--beam` to enable the bundled Beam catalog's 30-second
refresh as another plugin-state polling control. Run each attribution cell once;
these runs establish source/count evidence, not an improvement distribution.
No operator state, external provider, or real credentials are used.

Count statements, worker requests, and main-thread statements with the frozen
observer. Attribute each steady namespace list to its plugin, caller, timer,
and namespace; count writes between successive polls. Keep boot, steady, and
shutdown separate. Capture per-thread CPU profiles to establish call paths;
no elapsed-time or CPU-speed improvement is claimed by attribution runs.

Before production edits, publish the attribution and proposed owner-level change
for coordinator design approval. If a live pattern does not reproduce on current
main, stop that item and record the gap. Preserve supported external writers,
TTL visibility, write receipts, recovery, and final effect authority. Reuse the
existing owner and invalidation machinery; no new cache, generation, schema,
or freshness probe is proposed.

For a later approved candidate, require fewer target steady statements and
requests, no increase in warm-turn statements or requests, and zero runtime
main-thread SQL. Run three alternating baseline/candidate pairs on the same
platform when host load is below 64 and internal free space is at least 12 GiB;
otherwise use one pair and disclose the reduced count evidence. Report median
and range per phase and per operation. A wall-clock or CPU-time claim requires
at least five alternating samples per arm under the campaign timing lock with
load below 24, separate cold/warm median, p95, and range. Any adverse 20% cell
stops the candidate for disposition.
