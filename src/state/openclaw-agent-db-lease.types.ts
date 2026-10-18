import type { SqliteIntegrityCheck } from "../infra/sqlite-integrity.js";
import type {
  OpenClawAgentDatabaseWorkerLeaseReceipt,
  OpenClawAgentIntegrityVerificationReceiver,
} from "./openclaw-agent-db-lease.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";

/** Prepared state-owner facts remain a claim, never an admission grant. */
export type PreparedOpenClawAgentDatabaseWorkerLease = {
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
  provenance: string | null;
  validation?: OpenClawAgentDatabaseValidation;
  deferUnverifiedIntegrity?: boolean;
  startupRepair?: (
    check: SqliteIntegrityCheck,
    error: unknown,
    assertCurrent: () => void,
  ) => boolean;
  claim(onVerification?: OpenClawAgentIntegrityVerificationReceiver): string;
};
