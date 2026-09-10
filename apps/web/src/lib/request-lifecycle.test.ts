import { describe, expect, it, vi } from "vitest";
import { api, endpoints } from "./api";
import { conversationDeleted, localDeletions, markConversationsDeleted } from "./conversation-lifecycle";
import { offlineStore } from "./offline-history";

describe("explicit conversation request ownership", () => {
  it.each([
    ["message retry", (id: string) => endpoints.retryGeneration(id, "message")],
    ["version selection", (id: string) => endpoints.selectGeneration(id, "message", "generation")],
    ["generation cancellation", (id: string) => endpoints.cancelGeneration(id, "generation")],
    ["approval", (id: string) => endpoints.resolveToolCall(id, "tool-call", true)],
    ["image retry", (id: string) => endpoints.retryImageGeneration(id, "image-job")],
    ["image cancellation", (id: string) => endpoints.cancelImageGeneration(id, "image-job")]
  ] as const)("handles a missing conversation during %s without parsing resource URLs", async (_name, request) => {
    const id = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "conversation_not_found", message: "deleted" } }, { status: 404 })));
    await expect(request(id)).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(conversationDeleted(id)).toBe(true);
  });

  it("does not infer ownership from the path of a generic HTTP request", async () => {
    const id = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "conversation_not_found" } }, { status: 404 })));
    await expect(api.get(`/api/conversations/${id}`)).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(conversationDeleted(id)).toBe(false);
  });

  it("cancels owned requests and discards late data after a successful deletion", async () => {
    const id = crypto.randomUUID();
    let finish!: (response: Response) => void;
    let readSignal!: AbortSignal;
    const fetch = vi.fn((_path: string, init: RequestInit) => {
      if (init.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      readSignal = init.signal!;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = endpoints.generation(id, "generation");
    const lateResult = expect(pending).rejects.toMatchObject({ code: "conversation_deleted_local" });
    await endpoints.deleteConversation(id);
    expect(readSignal.aborted).toBe(true);
    expect(localDeletions.has(id)).toBe(false);
    finish(Response.json({ stale: true }));
    await lateResult;
    await expect(endpoints.updateConversation(id, { draft: "late" })).rejects.toMatchObject({ code: "conversation_deleted_local" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not enter offline mode when deletion aborts a tracked fetch", async () => {
    const id = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const pending = endpoints.messages(id);
    const rejected = expect(pending).rejects.toMatchObject({ code: "conversation_deleted_local" });
    markConversationsDeleted([id]);
    await rejected;
    expect(offlineStore.get().offline).toBe(false);
  });

  it.each([400, 401, 500])("does not mark deletion when DELETE fails with HTTP %s", async (status) => {
    const id = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "request_failed" } }, { status })));
    await expect(endpoints.deleteConversation(id)).rejects.toMatchObject({ status });
    expect(conversationDeleted(id)).toBe(false);
    expect(localDeletions.has(id)).toBe(false);
  });

  it("does not interpret a missing resource or offline snapshot as a deleted conversation", async () => {
    const id = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "generation_not_found" } }, { status: 404 })));
    await expect(endpoints.generation(id, "missing")).rejects.toMatchObject({ code: "generation_not_found" });
    expect(conversationDeleted(id)).toBe(false);
    offlineStore.set({ offline: true });
    await expect(endpoints.messages(id)).rejects.toMatchObject({ code: "network_error" });
    expect(conversationDeleted(id)).toBe(false);
  });
});
