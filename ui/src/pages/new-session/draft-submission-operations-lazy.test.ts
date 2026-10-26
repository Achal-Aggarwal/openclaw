import { afterEach, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { getChatAttachmentDataUrl } from "../chat/attachment-payload-store.ts";
import {
  createDraftFixture,
  readyChatRoute,
  registerTextPayload,
  resetSubmissionMocks,
  stubObjectUrls,
} from "./draft-submission-flow.test-support.ts";

const operationsImport = vi.hoisted(() => ({
  calls: 0,
  failed: Promise.withResolvers<void>(),
  ready: Promise.withResolvers<void>(),
}));

vi.mock("./draft-submission-operations.runtime.ts", async (importOriginal) => {
  if (++operationsImport.calls === 1) {
    await operationsImport.failed.promise;
    throw new Error("Submission code unavailable");
  }
  await operationsImport.ready.promise;
  return importOriginal();
});

afterEach(async () => {
  operationsImport.failed.resolve();
  operationsImport.ready.resolve();
  await vi.dynamicImportSettled();
  resetSubmissionMocks();
});

it("retains draft custody on import failure and rechecks held submissions before writing", async () => {
  stubObjectUrls("blob:failed-submission", "blob:original-submission");
  const failed = createDraftFixture();
  const failedAttachment = registerTextPayload("failed-submission");
  failed.flow.setMessage("Keep this unsent draft");
  failed.flow.attachmentDraft.replace([failedAttachment]);
  const failure = failed.flow.submit();
  expect(failed.flow.submitting).toBe(true);
  expect(failed.context.sessions.createResult).not.toHaveBeenCalled();
  operationsImport.failed.resolve();
  await failure;
  expect(failed.flow.error).toBeTruthy();
  expect(failed.flow.submitting).toBe(false);
  expect(failed.flow.message).toBe("Keep this unsent draft");
  expect(failed.flow.attachmentDraft.attachments).toEqual([failedAttachment]);
  expect(getChatAttachmentDataUrl(failedAttachment)).not.toBeNull();
  expect(failed.context.sessions.createResult).not.toHaveBeenCalled();

  const original = createDraftFixture({ takePreparedTitle: () => "Captured title" });
  const attachment = registerTextPayload("original-submission");
  original.flow.setMessage("  @Alex original request  ", [{ profileId: "alex", start: 2, end: 7 }]);
  original.flow.attachmentDraft.replace([attachment]);
  vi.mocked(original.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:loaded-submission",
    initialRun: { status: "started", runId: "loaded-submission-run" },
  });
  vi.mocked(original.context.navigateAndWait).mockImplementation(readyChatRoute);
  const admitted = original.flow.submit();
  const duplicate = original.flow.submit();
  expect(original.flow.submitting).toBe(true);
  expect(original.flow.pendingMessage?.content).toContainEqual({
    type: "text",
    text: "@Alex original request",
  });
  expect(original.context.sessions.createResult).not.toHaveBeenCalled();
  original.flow.setMessage("A newer draft");

  const retired = createDraftFixture();
  retired.flow.setMessage("Retire before creating");
  const retirement = retired.flow.submit();
  retired.flow.invalidate("gateway-changed");
  expect(retired.flow.submissionOutcomeUnknown).toBeNull();
  expect(retired.flow.submitting).toBe(false);

  const disconnected = createDraftFixture();
  disconnected.flow.setMessage("Disconnect before creating");
  const disconnection = disconnected.flow.submit();
  disconnected.flow.disconnect();

  const replaced = createDraftFixture();
  replaced.flow.setMessage("Replace the connection before creating");
  const replacement = replaced.flow.submit();
  replaced.context.gateway.snapshot.client = createTestGatewayClient(async () => ({}));

  const relocated = createDraftFixture();
  relocated.flow.setMessage("Replace the Gateway URL before creating");
  const relocation = relocated.flow.submit();
  relocated.context.gateway.connection.gatewayUrl = "ws://replacement.example";

  const scoped = createDraftFixture();
  scoped.flow.setMessage("Replace the recovery owner before creating");
  const rescope = scoped.flow.submit();
  const scopedAuth = scoped.context.gateway.snapshot.hello?.auth;
  if (!scopedAuth) {
    throw new Error("Expected connected recovery owner");
  }
  scopedAuth.recoveryScope = "principal-b";

  const revoked = createDraftFixture();
  revoked.flow.setMessage("Revoke submission access before creating");
  const revocation = revoked.flow.submit();
  const features = revoked.context.gateway.snapshot.hello?.features;
  if (!features) {
    throw new Error("Expected connected Gateway features");
  }
  features.methods = [];

  operationsImport.ready.resolve();
  await Promise.all([
    admitted,
    duplicate,
    retirement,
    disconnection,
    replacement,
    relocation,
    rescope,
    revocation,
  ]);
  expect(original.context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: "@Alex original request",
      mentions: [{ profileId: "alex", start: 0, end: 5 }],
      displayName: "Captured title",
      attachments: [
        expect.objectContaining({
          fileName: "original-submission.txt",
          content: btoa("original-submission"),
        }),
      ],
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(original.flow.message).toBe("A newer draft");
  for (const fixture of [retired, disconnected, replaced, relocated, scoped, revoked]) {
    expect(fixture.context.sessions.createResult).not.toHaveBeenCalled();
  }
  expect(revoked.flow.error).toBeTruthy();
  expect(revoked.flow.submitting).toBe(false);
  for (const fixture of [
    failed,
    original,
    retired,
    disconnected,
    replaced,
    relocated,
    scoped,
    revoked,
  ]) {
    fixture.flow.disconnect();
  }
});
