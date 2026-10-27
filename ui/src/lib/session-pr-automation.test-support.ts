import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { expect, vi } from "vitest";
import { CronAddParamsSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob } from "../api/types.ts";
import { setCiAutomationEnabled } from "./session-pr-automation-operation.ts";
import type { CiAutomationOption, CiAutomationTarget } from "./session-pr-automation-spec.ts";

export function readCiAutomationAddParams(value: unknown) {
  if (
    !Value.Check(CronAddParamsSchema, value) ||
    value.enabled !== true ||
    typeof value.agentId !== "string" ||
    typeof value.sessionKey !== "string" ||
    value.payload.kind !== "agentTurn"
  ) {
    throw new Error("Expected an enabled session-owned agent-turn automation request");
  }
  return {
    ...value,
    enabled: value.enabled,
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    payload: value.payload,
  };
}

export async function createCiAutomationJobFixture(
  target: CiAutomationTarget,
  option: CiAutomationOption,
  overrides: Partial<CronJob> = {},
): Promise<CronJob> {
  const request = vi
    .fn<GatewayBrowserClient["request"]>()
    .mockImplementation(async (method, params) => {
      expect(method).toBe("cron.add");
      const job: CronJob = {
        ...readCiAutomationAddParams(params),
        id: option,
        createdAtMs: 1,
        updatedAtMs: 1,
        state: {},
        configRevision: "revision-1",
      };
      return { job };
    });
  const client = { request } as unknown as GatewayBrowserClient;
  const job = expectDefined(
    await setCiAutomationEnabled(client, target, option, true, undefined),
    "created automation fixture",
  );
  return { ...job, ...overrides };
}
