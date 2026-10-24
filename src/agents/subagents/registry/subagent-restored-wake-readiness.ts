import type { SubagentRunRecord } from "./subagent-registry.types.js";
/** Unadmitted retained receipts are not runnable foreground inputs. */
export function isRestoredRequesterWakeRunnable(entry: SubagentRunRecord, _rows: Iterable<SubagentRunRecord>, _pauseNotice: boolean): boolean {
 const wake = entry.requesterSettleWake;
 return Boolean(wake && !(wake.status === "pending" && wake.attemptCount === 0) && !entry.collect && !entry.suppressCompletionDelivery);
}
