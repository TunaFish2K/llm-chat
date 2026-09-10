import type { GenerationNotificationState } from "@llm-chat/contracts";
import type { Store } from "./database";
import type { EventHub } from "./events";

export function generationNotificationState(store: Store, id: string): GenerationNotificationState | undefined {
  const row = store.sqlite.prepare(`SELECT g.id, g.assistant_message_id, g.status, g.stop_reason,
    m.conversation_id, c.title FROM generations g
    JOIN messages m ON m.id = g.assistant_message_id JOIN conversations c ON c.id = m.conversation_id
    WHERE g.id = ? AND m.history_active = 1`).get(id);
  if (!row) return undefined;
  return {
    generationId: String(row.id), messageId: String(row.assistant_message_id),
    conversationId: String(row.conversation_id), conversationTitle: String(row.title),
    status: String(row.status) as GenerationNotificationState["status"],
    stopReason: row.stop_reason == null ? null : String(row.stop_reason),
    pendingTools: store.sqlite.prepare(`SELECT id, name, step_index FROM generation_tool_calls
      WHERE generation_id = ? AND approval_state = 'pending' ORDER BY call_index`).all(id)
      .map((call) => ({ id: String(call.id), name: String(call.name), stepIndex: Number(call.step_index) }))
  };
}

export function activeGenerationNotifications(store: Store): GenerationNotificationState[] {
  return store.sqlite.prepare("SELECT id FROM generations WHERE status IN ('queued', 'running', 'waiting-approval')").all()
    .flatMap((row) => { const state = generationNotificationState(store, String(row.id)); return state ? [state] : []; });
}

export function publishGenerationState(store: Store, events: EventHub, id: string): void {
  const generation = generationNotificationState(store, id);
  if (generation) events.emit({ type: "generation-state", generation });
}
