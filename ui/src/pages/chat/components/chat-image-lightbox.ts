import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { openResolvedImage } from "./chat-image-presentation.ts";

registerChatMediaEnglish();

export function isImageLightboxEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) => target instanceof HTMLElement && target.localName === "openclaw-image-lightbox",
    );
}

export function openInlineChatImage(
  event: Event,
  onOpenImage: ((item: ImageLightboxItem) => void) | undefined,
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  const target = event
    .composedPath()
    .find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        (candidate.classList.contains("markdown-inline-image") ||
          candidate.classList.contains("markdown-inline-image-button")),
    );
  const image =
    target instanceof HTMLImageElement
      ? target
      : (target?.querySelector<HTMLImageElement>(".markdown-inline-image") ?? null);
  if (!image || image.closest("a")) {
    return false;
  }
  event.preventDefault();
  const src = image.currentSrc || image.src;
  const title = image.alt.trim() || t("chat.imageLightbox.untitled");
  openResolvedImage(onOpenImage, src, title);
  return true;
}
