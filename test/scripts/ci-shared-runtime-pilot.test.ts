import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPilotPlan,
  measurePilotCommand,
  pilotRowEnvironment,
  summarizePilotReceipts,
  type PilotReceipt,
} from "../../scripts/ci-shared-runtime-pilot.mts";
import { NODE_WORKER_E2E_TEST_FILES } from "../../scripts/lib/ci-node-worker-e2e-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
describe("shared-runtime qualification execution", () => {
  it("retains every existing worker target once with prebuilt runtime and serial two-worker execution", () => {
    const plan = createPilotPlan();
    const targets = plan.flatMap((row) => row.targets ?? []);
    expect(targets.toSorted()).toEqual(NODE_WORKER_E2E_TEST_FILES.toSorted());
    expect(new Set(targets).size).toBe(targets.length);
    for (const row of plan) {
      const env = pilotRowEnvironment(row, { CI: "true" });
      expect(JSON.parse(env.OPENCLAW_NODE_TEST_TARGETS_JSON)).toEqual(row.targets);
      expect(env.OPENCLAW_E2E_USE_PREBUILT_DIST).toBe("1");
      expect(env.OPENCLAW_NODE_TEST_PLAN_CONCURRENCY).toBe("1");
      expect(env.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
    }
  });
  it("records and returns a real child failure rather than creating a passing receipt", async () => {
    const file = path.join(temps.make("pilot-measure-"), "receipt.json");
    const code = await measurePilotCommand(
      "negative-proof",
      file,
      [process.execPath, "-e", "process.exit(7)"],
      { ...process.env, GITHUB_SHA: "a".repeat(40) },
    );
    expect(code).toBe(7);
    const receipt: PilotReceipt = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(receipt.exitCode).toBe(7);
    expect(receipt.revision).toBe("a".repeat(40));
    expect(receipt.finishedAt).toBeGreaterThanOrEqual(receipt.startedAt);
    expect(receipt.seconds).toBeGreaterThan(0);
    expect(() => summarizePilotReceipts([receipt])).toThrow("Qualification failed");
    const successful = { ...receipt, exitCode: 0 };
    expect(() => summarizePilotReceipts([successful, successful])).toThrow("Duplicate");
    expect(() =>
      summarizePilotReceipts([
        successful,
        { ...successful, label: "other", revision: "b".repeat(40) },
      ]),
    ).toThrow("identity mismatch");
  });
});
