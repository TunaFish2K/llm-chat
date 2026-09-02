import { describe, expect, it, vi } from "vitest";
import { makeBackgroundTask, makeMessage } from "../../test/fixtures";
import { appStore, loadMessages, refreshTaskCounts } from "./app-state";

describe("message compatibility", () => {
  it("normalizes attachment and generation arrays omitted by an older server", async () => {
    const { attachments: _attachments, generations: _generations, ...legacyMessage } = makeMessage({
      id: "legacy-user",
      role: "user",
      text: "旧服务消息"
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([legacyMessage]), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));

    const messages = await loadMessages("conv-legacy");

    expect(messages[0]).toMatchObject({ attachments: [], generations: [] });
    expect(appStore.get().messages["conv-legacy"]?.[0]).toMatchObject({ attachments: [], generations: [] });
  });
});

describe("background task counts", () => {
  it("groups active tasks by their owning conversation", async () => {
    const tasks = [
      makeBackgroundTask({ id: "running-1", conversationId: "conv-1", status: "running" }),
      makeBackgroundTask({ id: "queued-1", conversationId: "conv-1", status: "queued" }),
      makeBackgroundTask({ id: "running-2", conversationId: "conv-2", status: "starting" }),
      makeBackgroundTask({ id: "done", conversationId: "conv-2", status: "completed" })
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tasks), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    appStore.set({ runningTasksByConversation: { stale: 4 } });

    await refreshTaskCounts();

    expect(appStore.get().runningTasksByConversation).toEqual({ "conv-1": 2, "conv-2": 1 });
  });
});
