import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageSessionSummaryDto } from "@llm-chat/contracts";
import { endpoints } from "./api";
import { imageStudioStore, refreshImageSessions, resetImageStudioState } from "./image-studio-state";

const session: ImageSessionSummaryDto = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Concept",
  coverAsset: null,
  nodeCount: 0,
  activeCount: 0,
  createdAt: 1,
  updatedAt: 1
};

afterEach(() => {
  vi.restoreAllMocks();
  resetImageStudioState();
});

describe("image studio state", () => {
  it("publishes refreshed sessions and a recoverable failure", async () => {
    vi.spyOn(endpoints, "imageSessions").mockResolvedValueOnce([session]).mockRejectedValueOnce(new Error("offline"));
    await expect(refreshImageSessions()).resolves.toEqual([session]);
    expect(imageStudioStore.get()).toEqual({ sessions: [session], loading: false, error: null });
    await expect(refreshImageSessions()).rejects.toThrow("offline");
    expect(imageStudioStore.get()).toEqual({ sessions: [session], loading: false, error: "offline" });
  });

  it("does not let an older request or a reset overwrite newer state", async () => {
    let resolveOlder!: (sessions: ImageSessionSummaryDto[]) => void;
    const older = new Promise<ImageSessionSummaryDto[]>((resolve) => { resolveOlder = resolve; });
    vi.spyOn(endpoints, "imageSessions").mockReturnValueOnce(older).mockResolvedValueOnce([{ ...session, title: "Newer" }]);
    const pending = refreshImageSessions();
    await refreshImageSessions();
    resolveOlder([session]);
    await pending;
    expect(imageStudioStore.get().sessions[0]?.title).toBe("Newer");

    let resolveAfterReset!: (sessions: ImageSessionSummaryDto[]) => void;
    vi.mocked(endpoints.imageSessions).mockReturnValueOnce(new Promise((resolve) => { resolveAfterReset = resolve; }));
    const stale = refreshImageSessions();
    resetImageStudioState();
    resolveAfterReset([session]);
    await stale;
    expect(imageStudioStore.get()).toEqual({ sessions: [], loading: false, error: null });
  });
});
