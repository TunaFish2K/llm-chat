import { createStore } from "./store";
import { apiCredentials, assetUrl } from "./server-channel";

export interface PreviewImage {
  /** Full-size image shown in the viewer and offered as the original. */
  url: string;
  fileName: string;
  /** Opened by "view original" when it differs from the shown url, e.g. a proxied external image. */
  sourceUrl?: string | undefined;
}

/** The single app-wide image viewer; galleries open it instead of navigating to the file. */
export const imagePreviewStore = createStore<{ images: PreviewImage[]; index: number; open: boolean }>({ images: [], index: 0, open: false });

export function openImagePreview(images: PreviewImage[], index = 0): void {
  if (!images.length) return;
  imagePreviewStore.set({ images, index: Math.min(Math.max(index, 0), images.length - 1), open: true });
}

export function closeImagePreview(): void {
  imagePreviewStore.set({ open: false });
}

/** Saves an image as a file; a plain download link would only open it when the API is on another origin. */
export async function downloadImage(image: Pick<PreviewImage, "url" | "fileName">): Promise<void> {
  const url = assetUrl(image.url) ?? image.url;
  const response = await fetch(url, { credentials: apiCredentials() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = withExtension(image.fileName || "image", blob.type);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

/** Markdown images are named after their alt text, which rarely carries an extension. */
function withExtension(name: string, mimeType: string): string {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" }[mimeType];
  return !extension || /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extension}`;
}
