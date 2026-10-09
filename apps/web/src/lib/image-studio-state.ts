import type { ImageSessionSummaryDto } from "@llm-chat/contracts";
import { endpoints } from "./api";
import { createStore } from "./store";

interface ImageStudioState {
  sessions: ImageSessionSummaryDto[];
  loading: boolean;
  error: string | null;
}

export const imageStudioStore = createStore<ImageStudioState>({ sessions: [], loading: false, error: null });
let sequence = 0;

export async function refreshImageSessions(): Promise<ImageSessionSummaryDto[]> {
  const ticket = ++sequence;
  imageStudioStore.set({ loading: true, error: null });
  try {
    const sessions = await endpoints.imageSessions();
    if (ticket === sequence) imageStudioStore.set({ sessions, loading: false, error: null });
    return sessions;
  } catch (error) {
    if (ticket === sequence) imageStudioStore.set({
      loading: false,
      error: error instanceof Error ? error.message : "Unable to load image sessions"
    });
    throw error;
  }
}

export function resetImageStudioState(): void {
  sequence++;
  imageStudioStore.set({ sessions: [], loading: false, error: null });
}
