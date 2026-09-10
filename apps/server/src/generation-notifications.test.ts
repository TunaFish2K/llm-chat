import { afterEach, expect, it, vi } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { activeGenerationNotifications, generationNotificationState, publishGenerationState } from "./generation-notifications";
import { EventHub } from "./events";

afterEach(cleanupStores);

it("projects active state and pending batches without disclosing tool arguments or output", () => {
  const store = createStore(); const { model } = seedModel(store);
  const started = store.startConversation({ text: "private message", modelId: model.id, contextPolicy: "full" });
  const id = started.generation.generationId;
  store.upsertToolCall(id, { id: "call", name: "workspace_shell", arguments: '{"command":"secret"}' }, 0, 0, true);
  store.upsertToolCall(id, { id: "automatic", name: "get_time_info", arguments: "{}" }, 1, 0, false);
  store.setGenerationWaitingApproval(id);
  const value = generationNotificationState(store, id)!;
  expect(value).toMatchObject({ generationId: id, conversationId: started.conversation.id,
    messageId: started.generation.assistantMessageId, status: "waiting-approval",
    pendingTools: [{ id: "call", name: "workspace_shell", stepIndex: 0 }] });
  expect(JSON.stringify(value)).not.toContain("secret");
  expect(activeGenerationNotifications(store)).toEqual([value]);
  const hub = new EventHub(); const listener = vi.fn(); hub.subscribe(0, listener);
  publishGenerationState(store, hub, id);
  expect(listener).toHaveBeenCalledWith({ type: "generation-state", id: 1, generation: value });
  expect(hub.cursor).toBe(1);
  store.finishGeneration(id, "completed", { stopReason: "stop" });
  expect(activeGenerationNotifications(store)).toEqual([]);
  expect(generationNotificationState(store, id)?.stopReason).toBe("stop");
  expect(generationNotificationState(store, "missing")).toBeUndefined();
  publishGenerationState(store, hub, "missing"); expect(hub.cursor).toBe(1);
  store.sqlite.prepare("UPDATE messages SET history_active = 0 WHERE id = ?").run(started.generation.assistantMessageId);
  expect(generationNotificationState(store, id)).toBeUndefined();
});
