import { errorI18n } from "@llm-chat/i18n";
import type { Store } from "./database";
import type { GenerationRunner } from "./generations";
import type { ImageService } from "./images";
import type { EventHub } from "./events";
import { publishGenerationState } from "./generation-notifications";

export class MessageQueue {
  private readonly active = new Set<string>();
  private readonly again = new Set<string>();
  private closing = false;
  private readonly work = new Set<Promise<void>>();
  constructor(private readonly store: Store, private readonly runner: GenerationRunner,
    private readonly images: ImageService, private readonly events: EventHub,
    private readonly validate: (conversationId: string, assets: string[]) => void) {}

  changed(conversationId: string): void { this.events.emit({ type: "message-queue", conversationId }); }

  initialize(): void {
    // A committed but never started dispatch can reuse its existing messages and generation.
    this.store.sqlite.exec(`UPDATE generations SET status = 'queued', completed_at = NULL
      WHERE status = 'interrupted' AND started_at IS NULL
      AND id IN (SELECT generation_id FROM queued_messages WHERE status = 'dispatching')`);
    for (const conversation of this.store.listConversations()) this.kick(conversation.id);
  }

  kick(conversationId: string): void {
    if (this.closing) return;
    if (this.active.has(conversationId)) { this.again.add(conversationId); return; }
    this.active.add(conversationId);
    const work = this.drain(conversationId).finally(() => {
      this.active.delete(conversationId); this.work.delete(work);
      if (this.again.delete(conversationId)) this.kick(conversationId);
    });
    this.work.add(work);
    void work.catch((error) => console.error("Message queue dispatch failed", conversationId, error));
  }

  private async drain(conversationId: string): Promise<void> {
    while (!this.closing && this.store.getConversation(conversationId) && !this.runner.isConversationActive(conversationId)) {
      if (this.store.sqlite.prepare("SELECT queue_paused FROM conversations WHERE id = ?").get(conversationId)?.queue_paused) return;
      const items = this.store.listQueuedMessages(conversationId);
      const dispatch = items.find((item) => item.status === "dispatching");
      if (dispatch?.generationId) {
        const generation = this.store.getGeneration(dispatch.generationId);
        if (generation?.status === "queued") {
          const row = this.store.sqlite.prepare("SELECT assistant_message_id FROM generations WHERE id = ?").get(dispatch.generationId)!;
          const message = this.store.listMessages(conversationId).find((item) => item.id === String(row.assistant_message_id));
          const user = this.store.listMessages(conversationId).find((item) => item.ordinal === (message?.ordinal ?? 0) - 1);
          try {
            if (user) await this.images.materializeMessageAttachments(conversationId, user.id);
            if (this.closing) return;
            if (this.store.getGeneration(dispatch.generationId)?.status !== "queued") continue;
            this.runner.start(dispatch.generationId);
            this.store.sqlite.prepare("DELETE FROM queued_messages WHERE id = ?").run(dispatch.id);
            this.events.emit({ type: "message-queue", conversationId, generation: {
              generationId: dispatch.generationId, assistantMessageId: String(row.assistant_message_id)
            } });
            return;
          } catch (error) {
            if (this.store.getGeneration(dispatch.generationId)?.status !== "queued") continue;
            this.store.finishGeneration(dispatch.generationId, "failed", {
              ...(errorI18n(error) ? { i18n: errorI18n(error)! } : {}),
              code: "queue_attachment_failed", message: error instanceof Error ? error.message : "附件准备失败"
            });
            publishGenerationState(this.store, this.events, dispatch.generationId);
            this.store.sqlite.prepare("UPDATE queued_messages SET status = 'failed', error = ?, error_i18n_json = ? WHERE id = ?")
              .run(error instanceof Error ? error.message : "附件准备失败", errorI18n(error) ? JSON.stringify(errorI18n(error)) : null, dispatch.id);
            this.changed(conversationId);
            continue;
          }
        }
        if (generation && ["running", "waiting-approval"].includes(generation.status)) return;
        this.store.sqlite.prepare("DELETE FROM queued_messages WHERE id = ?").run(dispatch.id);
        this.changed(conversationId);
      }
      if (this.store.isConversationBusy(conversationId) || !items.some((item) => item.status === "pending")) return;
      this.store.dispatchQueuedMessage(conversationId, (assets) => this.validate(conversationId, assets));
      this.changed(conversationId);
    }
  }

  async close(): Promise<void> { this.closing = true; await Promise.allSettled(this.work); }
}
