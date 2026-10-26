import { expect, it } from "vitest";
import {
  projectionLane,
  targetDiscoveryLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import { runWithWorkerStartObserver } from "../infra/worker-request-diagnostics.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

it("prepares the first roster with one session reader worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const query = { agentId: "main", key: "agent:main:startup" };
    seedRow(query, { sessionId: "startup", updatedAt: 1, label: "Prepared on restart" });
    // Start from cold pools, independently of the fixture's database preparation.
    await Promise.all([projectionLane.pool.rotate(), targetDiscoveryLane.pool.rotate()]);
    const workers: string[] = [];
    using projection = await runWithWorkerStartObserver(
      (script) => workers.push(script),
      async () => {
        const owner = await createTestProjection({ cfg, modelCatalog: [] });
        try {
          await owner.ensureMaterialized();
          return owner;
        } catch (error) {
          owner.dispose();
          throw error;
        }
      },
    );
    expect(projection.capture(query)?.entry).toMatchObject({
      sessionId: "startup",
      label: "Prepared on restart",
    });
    expect(workers.filter((script) => script === "session-transcript.worker.js")).toHaveLength(1);
  });
});
