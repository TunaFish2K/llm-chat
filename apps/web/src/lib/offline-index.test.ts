import { beforeEach, expect, it, vi } from "vitest";
import { makeConversation, makeMessage } from "../../test/fixtures";
import { computeOfflineIndex } from "./offline-index-compute";

const snapshot = { sourceId: "source", revision: 1, conversation: makeConversation(), messages: [makeMessage({ role: "user", text: "![picture](https://example.com/photo.png)" })] };
beforeEach(() => { vi.resetModules(); });

it("computes identical metadata with an asynchronous fallback when workers are unavailable", async () => {
  vi.stubGlobal("Worker", undefined);
  const { prepareOfflineIndex } = await import("./offline-index");
  await expect(prepareOfflineIndex(snapshot)).resolves.toEqual(computeOfflineIndex(snapshot));
});

it("correlates concurrent worker requests", async () => {
  class TestWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    terminate() {}
    postMessage(value: { id: number; snapshot: typeof snapshot }) {
      queueMicrotask(() => this.onmessage?.({ data: { id: value.id, index: computeOfflineIndex(value.snapshot) } }));
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  const { prepareOfflineIndex } = await import("./offline-index");
  const second = { ...snapshot, revision: 2 };
  await expect(Promise.all([prepareOfflineIndex(snapshot), prepareOfflineIndex(second)])).resolves.toEqual([computeOfflineIndex(snapshot), computeOfflineIndex(second)]);
});

it.each(["constructor", "post", "error"])("recovers from a %s worker failure", async failure => {
  const terminate = vi.fn();
  class BrokenWorker {
    onmessage?: (event: unknown) => void;
    onerror?: () => void;
    constructor() { if (failure === "constructor") throw new Error("blocked"); }
    terminate = terminate;
    postMessage() {
      if (failure === "post") throw new Error("clone failed");
      queueMicrotask(() => this.onerror?.());
    }
  }
  vi.stubGlobal("Worker", BrokenWorker);
  const { prepareOfflineIndex } = await import("./offline-index");
  await expect(prepareOfflineIndex(snapshot)).resolves.toEqual(computeOfflineIndex(snapshot));
  await expect(prepareOfflineIndex(snapshot)).resolves.toEqual(computeOfflineIndex(snapshot));
  if (failure === "error") expect(terminate).toHaveBeenCalledOnce();
});
