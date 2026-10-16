import { createStore } from "./store";

export interface PreviewImage {
  /** Full-size image shown in the viewer, downloaded and shared. */
  url: string;
  fileName: string;
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
