import { randomUUID } from "node:crypto";
import type { ConversationHistoryDto, HistoryChangeInput } from "@llm-chat/contracts";
import { StoreError, type Store } from "./database";

export class ConversationHistory {
  constructor(private readonly store: Store) {}

  state(id: string): ConversationHistoryDto {
    const row = this.store.sqlite.prepare("SELECT history_revision, queue_paused FROM conversations WHERE id = ?").get(id);
    if (!row) throw new StoreError("conversation_not_found", "会话不存在");
    const active = this.store.listMessages(id);
    const visible = new Set(active.map((message) => message.id));
    const messages = new Map(this.store.listMessages(id, true).map((message) => [message.id, message]));
    const records = this.store.sqlite.prepare("SELECT * FROM conversation_history WHERE conversation_id = ? ORDER BY sequence DESC").all(id)
      .map((record) => ({ id: String(record.id), createdAt: Number(record.created_at), redo: Boolean(record.redo),
        messages: (JSON.parse(String(record.message_ids_json)) as string[]).flatMap((key) => {
          const message = messages.get(key); return message && !visible.has(key) ? [message] : [];
        }) })).filter((record) => record.messages.length);
    return { revision: Number(row.history_revision), canUndo: active.some((message) => message.role === "user" || message.imageGenerationJob),
      canRedo: records.some((record) => record.redo), queuePaused: Boolean(row.queue_paused), records };
  }

  check(id: string, revision: number): void {
    const row = this.store.sqlite.prepare("SELECT history_revision FROM conversations WHERE id = ?").get(id);
    if (!row) throw new StoreError("conversation_not_found", "会话不存在");
    if (Number(row.history_revision) !== revision) throw new StoreError("history_conflict", "对话已在其他操作中改变，请刷新后重试");
  }

  pause(id: string, paused: boolean): void {
    this.store.sqlite.prepare("UPDATE conversations SET queue_paused = ? WHERE id = ?").run(Number(paused), id);
  }

  change(id: string, input: HistoryChangeInput): ConversationHistoryDto {
    const { sqlite } = this.store;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.check(id, input.revision);
      if (this.store.isConversationBusy(id)) throw new StoreError("conversation_busy", "请等待当前生成停止");
      if (input.action === "redo") {
        const record = sqlite.prepare("SELECT * FROM conversation_history WHERE conversation_id = ? AND redo = 1 ORDER BY sequence DESC LIMIT 1").get(id);
        if (!record) throw new StoreError("history_empty", "没有可重做的内容");
        for (const key of JSON.parse(String(record.message_ids_json)) as string[]) {
          sqlite.prepare("UPDATE messages SET history_active = 1 WHERE id = ? AND conversation_id = ?").run(key, id);
        }
        sqlite.prepare("DELETE FROM conversation_history WHERE id = ?").run(String(record.id));
      } else {
        const messages = this.store.listMessages(id);
        let cutoff: number;
        if (input.action === "rewind") {
          const target = messages.find((message) => message.id === input.throughMessageId);
          if (!target || target.role !== "assistant") throw new StoreError("message_not_found", "回溯位置不存在");
          const nextUser = messages.find((message) => message.ordinal > target.ordinal && message.role === "user");
          cutoff = nextUser ? nextUser.ordinal - 1 : messages.at(-1)?.ordinal ?? 0;
        } else {
          const lastUser = messages.findLast((message) => message.role === "user");
          cutoff = lastUser ? lastUser.ordinal - 1 : (messages.findLast((message) => message.imageGenerationJob)?.ordinal ?? 1) - 1;
        }
        const removed = messages.filter((message) => message.ordinal > cutoff && !message.greeting);
        if (!removed.length) throw new StoreError("history_empty", "没有需要撤回的内容");
        sqlite.prepare(`INSERT INTO conversation_history VALUES (?, ?, ?, 1,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_history WHERE conversation_id = ?), ?)`)
          .run(randomUUID(), id, JSON.stringify(removed.map((message) => message.id)), id, Date.now());
        for (const message of removed) sqlite.prepare("UPDATE messages SET history_active = 0 WHERE id = ?").run(message.id);
        // A summary may include removed turns even when later messages exceed its ordinal.
        sqlite.prepare("DELETE FROM context_summaries WHERE conversation_id = ? AND through_ordinal > ?").run(id, cutoff);
      }
      sqlite.prepare("UPDATE conversations SET history_revision = history_revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    return this.state(id);
  }
}
