import type { ApplicationConfigCapability } from "../../../app/config.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../../lib/uploads.ts";
import { registerChatAttachmentPayload } from "../attachment-payload-store.ts";
import { admitAttachmentFiles, type ChatAttachmentLimits } from "./chat-attachment-admission.ts";
import { resizeChatAttachmentImage } from "./chat-attachment-image.runtime.ts";
import {
  readChatAttachmentFile,
  type ChatAttachmentReadLifecycle,
  type PendingChatAttachmentRead,
} from "./chat-attachment-reads.ts";

registerChatComposerEnglish();

const CHAT_ATTACHMENT_READ_TIMEOUT_MS = 15_000;

export function readAdmittedChatAttachmentFile(
  file: File,
  entry: PendingChatAttachmentRead,
  reads: ChatAttachmentReadLifecycle,
  props: {
    readSignal?: AbortSignal;
    attachmentLimits?: ChatAttachmentLimits;
    uploadConfig?: ApplicationConfigCapability;
  },
  signal: AbortSignal,
  compressWhenReady: boolean,
): void {
  const reader = new FileReader();
  let preparedFile = file;
  const preparation = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (outcome: "error" | "aborted") => {
    finish(outcome);
    try {
      reader.abort();
    } catch {
      // Ignore reader abort errors on stalled handles.
    }
  };
  const finish = (
    outcome: "ready" | "error" | "aborted",
    failureMessage = "chat.attachments.readFailed",
    retryCompression?: () => void,
  ) => {
    if (settled) {
      return;
    }
    settled = true;
    preparation.abort();
    clearTimeout(timer);
    timer = undefined;
    entry.cancel = undefined;
    entry.compress = undefined;
    if (outcome === "ready" && !uploadsEnabled(props.uploadConfig)) {
      if (reads.fail(entry)) {
        showToast({
          message: uploadsDisabledMessage(),
          placement: "top-center",
          severity: "error",
        });
      }
    } else if (outcome === "ready" && typeof reader.result === "string" && !signal.aborted) {
      const completedAttachment = registerChatAttachmentPayload({
        attachment: { ...entry.attachment, fileName: preparedFile.name },
        dataUrl: reader.result,
        file: preparedFile,
      });
      const ready = [...entry.destination.getAttachments(), completedAttachment];
      const readyIds = new Set(ready.map(({ id }) => id));
      // Publish only readable payloads, in admission order, before releasing send.
      entry.destination.onAttachmentsChange(
        reads
          .project(ready)
          .filter(({ attachment }) => readyIds.has(attachment.id))
          .map(({ attachment }) => attachment),
      );
      reads.complete(entry);
    } else if (outcome === "aborted" || signal.aborted) {
      reads.remove(entry);
    } else if (retryCompression) {
      reads.failCompression(entry, failureMessage, retryCompression);
    } else if (reads.fail(entry)) {
      showToast({ message: t(failureMessage), placement: "top-center", severity: "error" });
    }
    entry.destination.onPendingReadsChange?.(-1);
  };
  const abort = () => cancel("aborted");
  const onTimeout = () => cancel("error");
  const setProcessing = (processing: boolean) => {
    clearTimeout(timer);
    timer =
      processing && !settled ? setTimeout(onTimeout, CHAT_ATTACHMENT_READ_TIMEOUT_MS) : undefined;
  };
  // This read owns the FileReader and abort subscription through settlement, independent of rendering.
  entry.cancel = abort;
  const listenerOptions = { signal: preparation.signal };
  listen(signal, "abort", abort, { ...listenerOptions, once: true });
  listen(reader, "error", () => finish("error"), listenerOptions);
  listen(reader, "abort", () => finish("aborted"), listenerOptions);
  listen(reader, "load", () => finish("ready"), listenerOptions);
  listen(
    reader,
    "progress",
    (event) => {
      if (!settled && event.lengthComputable && event.total > 0) {
        reads.updateProgress(entry, Math.min(1, Math.max(0, event.loaded / event.total)));
        if (timer !== undefined) {
          setProcessing(true);
        }
      }
    },
    listenerOptions,
  );
  setProcessing(true);
  const readPreparedFile = (prepared: File) => {
    if (settled) {
      return;
    }
    // Intake reserved this file's batch share at its per-file ceiling; preparation can only shrink it.
    if (
      prepared.size > (entry.reservedBytes ?? Infinity) ||
      admitAttachmentFiles([prepared], props.attachmentLimits, 0, { notify: false }).length === 0
    ) {
      finish(
        "error",
        prepared.size === 0
          ? "chat.attachments.readFailed"
          : file.type.startsWith("video/")
            ? "chat.attachments.compressionTooLarge"
            : "chat.attachments.tooLargeToast",
      );
      return;
    }
    preparedFile = prepared;
    entry.attachment = {
      ...entry.attachment,
      mimeType: prepared.type || "application/octet-stream",
      sizeBytes: prepared.size,
    };
    setProcessing(true);
    try {
      reader.readAsDataURL(prepared);
    } catch {
      finish("error");
    }
  };
  const videoLimit = entry.reservedBytes ?? props.attachmentLimits?.maxBytes;
  const imageLimit = props.attachmentLimits?.maxImageBytes;
  if (videoLimit !== undefined && file.type.startsWith("video/") && file.size > videoLimit) {
    // Waiting for consent (and time queued for an encoder) is not a stalled file read.
    setProcessing(false);
    entry.preparation = "offer";
    entry.compress = () => {
      if (settled || preparation.signal.aborted || !entry.compress) {
        return;
      }
      entry.compress = undefined;
      entry.preparation = "compressing";
      reads.updateProgress(entry, 0);
      void (async () => {
        const { compressChatAttachmentVideo } = await import("./chat-attachment-video.ts");
        return compressChatAttachmentVideo(file, videoLimit, preparation.signal, (progress) =>
          reads.updateProgress(entry, Math.max(entry.progress ?? 0, progress * 0.95)),
        );
      })().then(readPreparedFile, (error: unknown) => {
        const reason = error instanceof Error ? error.message : "failed";
        const message =
          reason === "unsupported"
            ? "chat.attachments.compressionUnsupported"
            : reason === "too-large"
              ? "chat.attachments.compressionTooLarge"
              : "chat.attachments.compressionFailed";
        finish("error", message, () => {
          if (
            signal.aborted ||
            !uploadsEnabled(props.uploadConfig) ||
            !reads.retry(entry, file, props.attachmentLimits)
          ) {
            return;
          }
          readChatAttachmentFile(file, entry, reads, props);
          entry.compress?.();
        });
      });
    };
    reads.updateProgress(entry, 0);
  } else if (imageLimit !== undefined && file.type.startsWith("image/") && file.size > imageLimit) {
    void resizeChatAttachmentImage(file, imageLimit, preparation.signal, setProcessing).then(
      readPreparedFile,
      () => finish("error"),
    );
  } else {
    readPreparedFile(file);
  }
  if (compressWhenReady) {
    entry.compress?.();
  }
}
