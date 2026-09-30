import type { OfflineConversationDto } from "@llm-chat/contracts";
import { computeOfflineIndex } from "./offline-index-compute";
export { computeOfflineIndex } from "./offline-index-compute";

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: ReturnType<typeof computeOfflineIndex>) => void; reject: (error: unknown) => void }>();
let unavailable = false;

/** Compute before opening a write transaction; serialization never holds it open. */
export async function prepareOfflineIndex(snapshot: OfflineConversationDto): Promise<ReturnType<typeof computeOfflineIndex>> {
  if (!unavailable && typeof Worker !== "undefined") {
    try {
      if (!worker) {
        worker = new Worker(new URL("./offline-index.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = event => {
          const request = pending.get(event.data.id);
          if (!request) return;
          pending.delete(event.data.id);
          request.resolve(event.data.index);
        };
        worker.onerror = () => {
          unavailable = true; worker?.terminate(); worker = undefined;
          for (const request of pending.values()) request.reject(new Error("Offline index worker failed"));
          pending.clear();
        };
      }
      const id = ++sequence;
      return await new Promise<ReturnType<typeof computeOfflineIndex>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker!.postMessage({ id, snapshot }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    } catch { unavailable = true; }
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  return computeOfflineIndex(snapshot);
}
