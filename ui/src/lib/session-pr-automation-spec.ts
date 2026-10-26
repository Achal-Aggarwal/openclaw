import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CronAddParams,
  CronJob,
} from "../../../packages/gateway-protocol/src/schema/cron.types.js";

export const CI_AUTOMATION_OPTIONS = ["autoFix", "autoMerge", "autoArchive"] as const;
export type CiAutomationOption = (typeof CI_AUTOMATION_OPTIONS)[number];
export type CiAutomationOptions = Record<CiAutomationOption, boolean>;
export type CiAutomationTarget = {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  owner: string;
  repo: string;
  number: number;
};

/** PR work survives conversation resets; only archive targets a specific incarnation. */
export function ciAutomationDeclarationKey(
  target: CiAutomationTarget,
  option: CiAutomationOption,
): string {
  const identity = JSON.stringify([
    target.agentId,
    target.sessionKey,
    option === "autoArchive" ? target.sessionId : null,
    target.owner.toLowerCase(),
    target.repo.toLowerCase(),
    target.number,
  ]);
  return `session-pr:v1:${bytesToHex(sha256(new TextEncoder().encode(identity)))}:${option}`;
}

export function executionTarget(
  target: CiAutomationTarget,
  option: CiAutomationOption,
): CronAddParams["sessionTarget"] {
  return option === "autoArchive" ? "isolated" : `session:${target.sessionKey}`;
}

type BoundCronJob = Pick<
  CronJob,
  "declarationKey" | "agentId" | "sessionKey" | "owner" | "sessionTarget" | "payload"
>;

/** Enabled state and editable prose never determine which checkbox owns a job. */
export function ciAutomationJobMatches(
  job: BoundCronJob,
  target: CiAutomationTarget,
  option: CiAutomationOption,
): boolean {
  return (
    job.declarationKey === ciAutomationDeclarationKey(target, option) &&
    job.agentId === target.agentId &&
    job.sessionKey === target.sessionKey &&
    job.owner?.agentId === target.agentId &&
    job.owner.sessionKey === target.sessionKey &&
    job.sessionTarget === executionTarget(target, option) &&
    job.payload.kind === "agentTurn"
  );
}
