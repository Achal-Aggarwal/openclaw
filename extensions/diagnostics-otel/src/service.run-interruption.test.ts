import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import {
  collectTestMetrics,
  installRealOtelSdkTestHarness,
  installTestMeter,
} from "./service.real-sdk.test-support.js";
import { RUN_FIXTURE, startOtelService } from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();
type RunCompletedEvent = Extract<
  Parameters<typeof emitTrustedDiagnosticEvent>[0],
  { type: "run.completed" }
>;

test.each<Pick<RunCompletedEvent, "abortCause" | "timeoutPhase" | "timeoutSource">>([
  {},
  { abortCause: "user_abort" },
  { abortCause: "timeout", timeoutPhase: "tool_execution", timeoutSource: "idle" },
])("exports run interruption facts on spans only: %j", async (interruption) => {
  const { reader } = installTestMeter();
  await startOtelService({ traces: true, metrics: true });
  const outcome = interruption.abortCause ? "aborted" : "completed";
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    ...RUN_FIXTURE,
    durationMs: 100,
    outcome,
    ...interruption,
  });
  await waitForDiagnosticEventsDrained();

  const attributes = sdk.exporter
    .getFinishedSpans()
    .find((span) => span.name === "openclaw.run")?.attributes;
  expect(attributes).toMatchObject({ "openclaw.outcome": outcome });
  const duration = (await collectTestMetrics(reader)).find(
    (metric) => metric.descriptor.name === "openclaw.run.duration_ms",
  );
  expect(duration?.dataPoints).toHaveLength(1);
  for (const [field, attribute] of [
    ["abortCause", "openclaw.run.abort_cause"],
    ["timeoutPhase", "openclaw.run.timeout_phase"],
    ["timeoutSource", "openclaw.run.timeout_source"],
  ] as const) {
    expect(attributes?.[attribute]).toBe(interruption[field]);
    expect(duration?.dataPoints[0]?.attributes).not.toHaveProperty(attribute);
  }
});

test("omits unknown interruption values from untrusted JavaScript diagnostic inputs", async () => {
  await startOtelService({ traces: true });
  // JavaScript emitters do not enforce the diagnostic event's TypeScript enum fields.
  emitDiagnosticEvent({
    type: "run.completed",
    ...RUN_FIXTURE,
    durationMs: 100,
    outcome: "aborted",
    abortCause: "private-cause",
    timeoutPhase: "private-phase",
    timeoutSource: "private-source",
  } as unknown as RunCompletedEvent);
  await waitForDiagnosticEventsDrained();

  const attributes = sdk.exporter
    .getFinishedSpans()
    .find((span) => span.name === "openclaw.run")?.attributes;
  expect(attributes).toMatchObject({ "openclaw.outcome": "aborted" });
  for (const field of ["abort_cause", "timeout_phase", "timeout_source"]) {
    expect(attributes).not.toHaveProperty(`openclaw.run.${field}`);
  }
  expect(JSON.stringify(attributes)).not.toContain("private-");
});
