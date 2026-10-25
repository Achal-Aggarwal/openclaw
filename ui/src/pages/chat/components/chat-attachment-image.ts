import { base64ToBytes } from "../../../lib/bytes-base64.ts";

export function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const trimmed = dataUrl.trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(trimmed);
  const mimeType = match?.[1]?.toLowerCase();
  const base64 = match ? trimmed.slice(match[0].length).replace(/\s+/g, "") : undefined;
  if (!mimeType || !base64) {
    return null;
  }
  try {
    return {
      file: new File([base64ToBytes(base64)], `${baseName}.${mimeType.slice("image/".length)}`, {
        type: mimeType,
      }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

// Only PNG uploads opt into preparation. Other formats keep ordinary admission.
export function canResizeChatAttachment(file: File): boolean {
  return file.type === "image/png";
}

export type ChatAttachmentImageRequest = { file: File; maxBytes: number };
