import type { ApplicationConfigCapability } from "../../../app/config.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { generateAttachmentId } from "../attachment-payload-store.ts";
import {
  admitAttachmentFiles,
  attachmentReservationBytes,
  chatAttachmentBatchBytes,
  type ChatAttachmentLimits,
} from "./chat-attachment-admission.ts";

registerChatComposerEnglish();

type ChatAttachmentReadDestination = {
  getAttachments: () => ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
};

export type ChatAttachmentRead = {
  attachment: ChatAttachment;
  state: "reading" | "ready" | "error";
  errorMessage?: string;
  progress?: number;
  preparation?: "offer" | "compressing";
  compress?: () => void;
  reservedBytes?: number;
  cancel?: () => void;
  destination?: ChatAttachmentReadDestination;
};

export type PendingChatAttachmentRead = ChatAttachmentRead & {
  destination: ChatAttachmentReadDestination;
};

export class ChatAttachmentReadLifecycle {
  pendingReads = 0;
  revision = 0;
  failureCount = 0;
  private controller = new AbortController();
  private entries: ChatAttachmentRead[] = [];

  constructor(private onChange: () => void) {}

  retarget(destination: ChatAttachmentReadDestination, notify: () => void): void {
    this.onChange = notify;
    for (const entry of this.entries) {
      if (entry.destination) {
        entry.destination = destination;
      }
    }
  }

  private notify(): void {
    this.revision += 1;
    this.onChange();
  }

  get readSignal(): AbortSignal {
    return this.controller.signal;
  }

  pendingBytes(limits: ChatAttachmentLimits | undefined): number {
    return this.entries.reduce(
      (total, entry) =>
        total +
        (entry.state === "reading"
          ? (entry.reservedBytes ??
            attachmentReservationBytes(
              entry.attachment.sizeBytes ?? 0,
              entry.attachment.mimeType,
              limits,
            ))
          : 0),
      0,
    );
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1): void {
    if (this.controller.signal !== readSignal) {
      return;
    }
    this.pendingReads = Math.max(0, this.pendingReads + delta);
    this.notify();
  }

  begin(
    files: readonly File[],
    attachments: ChatAttachment[],
    destination: ChatAttachmentReadDestination,
    limits?: ChatAttachmentLimits,
    stagedBytes = 0,
  ): PendingChatAttachmentRead[] {
    this.project(attachments);
    let total = stagedBytes;
    const entries = files.map((file): PendingChatAttachmentRead => {
      const reservedBytes = attachmentReservationBytes(
        file.size,
        file.type,
        limits,
        file.type.startsWith("video/") ? (limits?.maxBatchBytes ?? Infinity) - total : Infinity,
      );
      total += reservedBytes;
      return {
        reservedBytes,
        attachment: {
          id: generateAttachmentId(),
          origin: "file",
          mimeType: file.type || "application/octet-stream",
          fileName: file.name || undefined,
          sizeBytes: file.size,
        },
        state: "reading",
        destination,
      };
    });
    this.entries.push(...entries);
    this.notify();
    return entries;
  }

  // Ready payloads remain owned by the composer. Reconcile their membership
  // while retaining unread slots in admission order across overlapping batches.
  project(attachments: readonly ChatAttachment[]): readonly ChatAttachmentRead[] {
    const current = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    this.entries = this.entries.filter((entry) => {
      const attachment = current.get(entry.attachment.id);
      if (attachment) {
        entry.attachment = attachment;
        current.delete(attachment.id);
      }
      return entry.state !== "ready" || attachment !== undefined;
    });
    for (const attachment of current.values()) {
      this.entries.push({ attachment, state: "ready" });
    }
    return this.entries;
  }

  complete(entry: ChatAttachmentRead): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    entry.state = "ready";
    entry.preparation = undefined;
    entry.compress = undefined;
    entry.cancel = undefined;
    this.notify();
  }

  fail(entry: ChatAttachmentRead): boolean {
    if (!this.entries.includes(entry)) {
      return false;
    }
    this.failureCount += 1;
    this.remove(entry);
    return true;
  }

  failCompression(entry: ChatAttachmentRead, message: string, retry: () => void): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    this.failureCount += 1;
    entry.state = "error";
    entry.errorMessage = message;
    entry.preparation = undefined;
    entry.compress = retry;
    entry.cancel = undefined;
    this.notify();
  }

  retry(entry: PendingChatAttachmentRead, file: File, limits?: ChatAttachmentLimits): boolean {
    if (!this.entries.includes(entry) || entry.state !== "error") {
      return false;
    }
    const stagedBytes =
      chatAttachmentBatchBytes(entry.destination.getAttachments()) + this.pendingBytes(limits);
    if (admitAttachmentFiles([file], limits, stagedBytes, { compressVideos: true }).length === 0) {
      return false;
    }
    entry.reservedBytes = attachmentReservationBytes(
      file.size,
      file.type,
      limits,
      (limits?.maxBatchBytes ?? Infinity) - stagedBytes,
    );
    entry.state = "reading";
    entry.errorMessage = undefined;
    entry.compress = undefined;
    entry.progress = undefined;
    this.notify();
    return true;
  }

  updateProgress(entry: ChatAttachmentRead, fraction: number): void {
    if (!this.entries.includes(entry) || entry.state !== "reading") {
      return;
    }
    entry.progress = fraction;
    this.notify();
  }

  remove(entry: ChatAttachmentRead): void {
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    entry.cancel?.();
    entry.cancel = undefined;
    this.notify();
  }

  abortReads(): void {
    const controller = this.controller;
    this.controller = new AbortController();
    this.entries = [];
    this.pendingReads = 0;
    controller.abort();
    this.notify();
  }
}

export function readChatAttachmentFile(
  file: File,
  entry: PendingChatAttachmentRead,
  reads: ChatAttachmentReadLifecycle,
  // Kept with the owner so control prop types never import the execution graph.
  props: {
    readSignal?: AbortSignal;
    attachmentLimits?: ChatAttachmentLimits;
    uploadConfig?: ApplicationConfigCapability;
  },
): void {
  const signal = props.readSignal ?? reads.readSignal;
  if (signal.aborted) {
    reads.remove(entry);
    return;
  }
  const loading = new AbortController();
  let cancelled = false;
  let compressWhenReady = false;
  const cancel = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    loading.abort();
    entry.cancel = undefined;
    reads.remove(entry);
    entry.destination.onPendingReadsChange?.(-1);
  };
  entry.cancel = cancel;
  listen(signal, "abort", cancel, { once: true, signal: loading.signal });
  entry.destination.onPendingReadsChange?.(1);
  const videoLimit = entry.reservedBytes ?? props.attachmentLimits?.maxBytes;
  if (videoLimit !== undefined && file.type.startsWith("video/") && file.size > videoLimit) {
    // Consent remains available immediately while the read implementation loads.
    entry.preparation = "offer";
    entry.compress = () => {
      if (cancelled || !entry.compress) {
        return;
      }
      compressWhenReady = true;
      entry.compress = undefined;
      entry.preparation = "compressing";
      reads.updateProgress(entry, 0);
    };
    reads.updateProgress(entry, 0);
  }
  void (async () => {
    try {
      const { readAdmittedChatAttachmentFile } = await import("./chat-attachment-reads.runtime.ts");
      if (cancelled) {
        return;
      }
      loading.abort();
      entry.cancel = undefined;
      readAdmittedChatAttachmentFile(file, entry, reads, props, signal, compressWhenReady);
    } catch {
      if (cancelled) {
        return;
      }
      cancelled = true;
      loading.abort();
      entry.cancel = undefined;
      if (reads.fail(entry)) {
        showToast({
          message: t("chat.attachments.readFailed"),
          placement: "top-center",
          severity: "error",
        });
      }
      entry.destination.onPendingReadsChange?.(-1);
    }
  })();
}
