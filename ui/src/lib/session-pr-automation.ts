import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../../../src/cron/service/list-page-validation.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import {
  CI_AUTOMATION_OPTIONS,
  ciAutomationDeclarationKey,
  ciAutomationJobMatches,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "./session-pr-automation-spec.ts";

export type CiAutomationJobs = Partial<Record<CiAutomationOption, CronJob>>;

/** Cron owns durable settings, execution and access; this is only a scoped projection. */
export async function loadCiAutomationJobs(
  client: GatewayBrowserClient,
  target: CiAutomationTarget,
  signal: AbortSignal,
): Promise<CiAutomationJobs> {
  const jobs: CiAutomationJobs = {};
  const declarations = CI_AUTOMATION_OPTIONS.map((option) => ({
    option,
    key: ciAutomationDeclarationKey(target, option),
  }));
  let offset = 0;
  let revision: string | undefined;
  do {
    const response = await client.request<CronJobsListResult>(
      "cron.list",
      {
        sessionKey: target.sessionKey,
        sessionAgentId: target.agentId,
        includeDisabled: true,
        includeDeliveryPreviews: false,
        limit: 200,
        offset,
      },
      { signal },
    );
    const page = readCanonicalCronListPage<CronJob>(response, 200);
    resolveCronListPageNextOffset(page, offset);
    if (revision && revision !== page.snapshotRevision) {
      throw new Error("Automation inventory changed. Refresh and try again.");
    }
    revision = page.snapshotRevision;
    for (const job of page.jobs) {
      const declaration = declarations.find(({ key }) => job.declarationKey === key);
      if (!declaration) {
        continue;
      }
      const { option } = declaration;
      if (!ciAutomationJobMatches(job, target, option) || jobs[option]) {
        throw new Error(
          "This CI automation was changed. Review it in Automations before continuing.",
        );
      }
      jobs[option] = job;
    }
    if (!page.hasMore) {
      return jobs;
    }
    offset += page.jobs.length;
  } while (!signal.aborted);
  signal.throwIfAborted();
  return jobs;
}
