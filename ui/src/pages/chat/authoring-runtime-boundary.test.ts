// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  discardDurableComposerRecovery,
  prepareDurableComposerRecovery,
  readDurableComposerDraft,
  restoreDurableComposerRecovery,
  retireDurableComposerDraft,
  retireDurableComposerDrafts,
  writeDurableComposerDraft,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload, type Host } from "./outbox-payloads.ts";

useChatSendBrowserFixture();

afterEach(() => {
  vi.doUnmock("./outbox-payloads.runtime.ts");
  vi.doUnmock("../../lib/chat/composer-draft-write.runtime.ts");
  vi.doUnmock("../../lib/chat/composer-draft-recovery.runtime.ts");
});

const owner = { gatewayOwner: "ws://authoring.test", recoveryScope: "original-account" };
const legacyScope = { ...owner, scopeKey: "global\u0000agent:main" };
const destination = { ...owner, scopeKey: "chat:v3:agent:main:ordinary\u0000agent:main" };
const draft = { revision: 1, text: "Unsent draft", attachments: [] };

function queuedAttachment() {
  const item: ChatQueueItem = {
    id: "queued-input",
    text: "Unsent input",
    createdAt: 1,
    attachments: [
      {
        id: "queued-attachment",
        mimeType: "text/plain",
        fileName: "queued.txt",
        dataUrl: "data:text/plain;base64,cXVldWVk",
      },
    ],
  };
  onTestFinished(() => releaseChatAttachmentPayloads(item.attachments ?? []));
  const host: Host = {
    connected: true,
    client: { recoveryScope: owner.recoveryScope, recoveryScopeReady: true },
    settings: { gatewayUrl: owner.gatewayOwner },
    sessionKey: "agent:main:ordinary",
  };
  return { host, item };
}

it("retains queued attachment input when its payload chunk fails to load", async () => {
  // mock-isolation: Simulate a rejected chunk without replacing any storage behavior.
  vi.doMock("./outbox-payloads.runtime.ts", () => {
    throw new Error("Synthetic payload chunk unavailable");
  });
  const { host, item } = queuedAttachment();
  await expect(prepareOutboxPayload(host, item)).resolves.toEqual({
    status: "failed",
    reason: "unavailable",
  });
  expect(item).toMatchObject({
    text: "Unsent input",
    attachments: [{ dataUrl: "data:text/plain;base64,cXVldWVk" }],
  });
  expect(item.attachmentPayload).toBeUndefined();
});

it("does not persist a queued attachment under an account selected during chunk loading", async () => {
  const started = createDeferred();
  const release = createDeferred();
  // mock-isolation: Delay the real module so ownership can change before evaluation.
  vi.doMock(import("./outbox-payloads.runtime.ts"), async (importOriginal) => {
    started.resolve();
    await release.promise;
    return importOriginal();
  });
  const { host, item } = queuedAttachment();
  const pending = prepareOutboxPayload(host, item);
  try {
    await awaitGateBeforeSettlement(started.promise, pending, "Payload import was bypassed");
    host.client = { recoveryScope: "replacement-account", recoveryScopeReady: true };
    release.resolve();
    await expect(pending).resolves.toEqual({ status: "failed", reason: "unavailable" });
    expect(item.attachmentPayload).toBeUndefined();

    // The same intact input can be explicitly admitted under the new account.
    await expect(prepareOutboxPayload(host, item)).resolves.toMatchObject({
      status: "ready",
      update: { attachmentPayload: { recoveryScope: "replacement-account" } },
    });
  } finally {
    release.resolve();
    await pending;
  }
});

async function savedRecovery() {
  // Seed storage without warming the facade whose first import failure is under test.
  const writer = await vi.importActual<
    typeof import("../../lib/chat/composer-draft-write.runtime.ts")
  >("../../lib/chat/composer-draft-write.runtime.ts");
  await expect(
    writer.writeDurableComposerDraft(legacyScope, draft, {
      expectedRevision: 0,
      writeId: "saved-draft",
    }),
  ).resolves.toEqual({ status: "persisted", revision: 1, writeId: "saved-draft" });
  const recovery = await prepareDurableComposerRecovery(owner);
  if (recovery.status !== "ready" || recovery.entries.length !== 1) {
    throw new Error("Expected one unresolved legacy draft");
  }
  return recovery.entries[0]!;
}

it("reports failed write and recovery chunks without losing the saved draft", async () => {
  const source = await savedRecovery();
  // mock-isolation: Reject only newly split chunks; reads and IndexedDB stay real.
  vi.doMock("../../lib/chat/composer-draft-write.runtime.ts", () => {
    throw new Error("Synthetic draft writer unavailable");
  });
  // mock-isolation: Reject the recovery chunk while keeping stored draft reads real.
  vi.doMock("../../lib/chat/composer-draft-recovery.runtime.ts", () => {
    throw new Error("Synthetic recovery chunk unavailable");
  });
  const failed = { status: "storage-failed" };
  await expect(
    writeDurableComposerDraft(
      legacyScope,
      { ...draft, revision: 2, text: "Edited input" },
      {
        expectedRevision: 1,
        expectedWriteId: "saved-draft",
        writeId: "replacement-draft",
      },
    ),
  ).resolves.toEqual(failed);
  await expect(retireDurableComposerDraft(legacyScope)).resolves.toEqual(failed);
  await expect(
    retireDurableComposerDrafts(owner, [
      { scopeKey: legacyScope.scopeKey, minimumRevision: 1, retireBeforeRevision: 2 },
    ]),
  ).resolves.toBe("storage-failed");
  await expect(prepareDurableComposerRecovery(owner)).resolves.toEqual(failed);
  await expect(discardDurableComposerRecovery(owner, source, () => true)).resolves.toEqual(failed);
  await expect(
    restoreDurableComposerRecovery(destination, source, 0, undefined, () => true, 0),
  ).resolves.toEqual(failed);
  await expect(readDurableComposerDraft(legacyScope)).resolves.toEqual({
    status: "found",
    draft: { ...draft, writeId: "saved-draft" },
  });
  await expect(readDurableComposerDraft(destination)).resolves.toEqual({ status: "not-found" });
  await expect(
    prepareDurableComposerRecovery({ ...owner, recoveryScope: "empty-account" }),
  ).resolves.toEqual({ status: "ready", entries: [] });
});

it.each(["restore", "discard"] as const)(
  "preserves a saved draft when its owner retires while the %s chunk is loading",
  async (operation) => {
    const source = await savedRecovery();
    const started = createDeferred();
    const release = createDeferred();
    // mock-isolation: Hold the real recovery engine, preserving its authority checks and writes.
    vi.doMock(
      import("../../lib/chat/composer-draft-recovery.runtime.ts"),
      async (importOriginal) => {
        started.resolve();
        await release.promise;
        return importOriginal();
      },
    );
    let current = true;
    const change = () =>
      operation === "restore"
        ? restoreDurableComposerRecovery(destination, source, 0, undefined, () => current, 0)
        : discardDurableComposerRecovery(owner, source, () => current);
    const pending = change();
    try {
      await awaitGateBeforeSettlement(started.promise, pending, "Recovery import was bypassed");
      current = false;
      release.resolve();
      await expect(pending).resolves.toEqual({ status: "conflict" });
      await expect(readDurableComposerDraft(legacyScope)).resolves.toEqual({
        status: "found",
        draft: { ...draft, writeId: "saved-draft" },
      });
      await expect(readDurableComposerDraft(destination)).resolves.toEqual({ status: "not-found" });

      current = true;
      await expect(change()).resolves.toMatchObject({
        status: operation === "restore" ? "persisted" : "discarded",
      });
      await expect(readDurableComposerDraft(legacyScope)).resolves.toMatchObject({
        status: "not-found",
      });
      if (operation === "restore") {
        await expect(readDurableComposerDraft(destination)).resolves.toMatchObject({
          status: "found",
          draft: { text: "Unsent draft" },
        });
      }
    } finally {
      release.resolve();
      await pending;
    }
  },
);
