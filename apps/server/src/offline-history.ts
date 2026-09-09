import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./database";

/** Track rendered history, including streaming changes that do not touch updated_at. */
export function migrateOfflineHistory(db: DatabaseSync): void {
  const add = (table: string, column: string, declaration: string) => {
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  };
  add("app_settings", "offline_source_id", "TEXT NOT NULL DEFAULT ''");
  add("conversations", "cache_revision", "INTEGER NOT NULL DEFAULT 0");
  const message = (id: string) => `SELECT conversation_id FROM messages WHERE id = ${id}`;
  const generation = (id: string) => message(`(SELECT assistant_message_id FROM generations WHERE id = ${id})`);
  const tool = (id: string) => generation(`(SELECT generation_id FROM generation_tool_calls WHERE id = ${id})`);
  const tables: Record<string, (row: string) => string> = {
    messages: (row) => `SELECT ${row}.conversation_id`,
    generations: (row) => message(`${row}.assistant_message_id`),
    generation_blocks: (row) => generation(`${row}.generation_id`),
    generation_tool_calls: (row) => generation(`${row}.generation_id`),
    message_file_assets: (row) => message(`${row}.message_id`),
    tool_call_file_assets: (row) => tool(`${row}.tool_call_id`),
    generation_vision_analyses: (row) => generation(`${row}.generation_id`),
    vision_analyses: (row) => `SELECT m.conversation_id FROM generation_vision_analyses v JOIN generations g ON g.id=v.generation_id JOIN messages m ON m.id=g.assistant_message_id WHERE v.analysis_id=${row}.id`,
    image_generation_jobs: (row) => `SELECT ${row}.conversation_id`,
    agents: (row) => `SELECT id FROM conversations WHERE agent_id=${row}.id`,
    file_assets: () => "SELECT id FROM conversations"
  };
  for (const [table, owners] of Object.entries(tables)) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS offline_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN UPDATE conversations SET cache_revision=cache_revision+1 WHERE id IN (${owners(row)}); END;`);
    }
  }
  const columns = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((row) => row.name).filter((name) => name !== "cache_revision");
  db.exec(`CREATE TRIGGER IF NOT EXISTS offline_conversation_update AFTER UPDATE OF ${columns.join(",")} ON conversations
    BEGIN UPDATE conversations SET cache_revision=cache_revision+1 WHERE id=NEW.id; END;`);
}

export function offlineSourceId(store: Store): string {
  const row = store.sqlite.prepare("SELECT offline_source_id AS id FROM app_settings WHERE id=1").get() as { id: string };
  if (row.id) return row.id;
  const id = randomUUID();
  store.sqlite.prepare("UPDATE app_settings SET offline_source_id=? WHERE id=1").run(id);
  return id;
}

export function offlineManifest(store: Store) {
  const revisions = new Map((store.sqlite.prepare("SELECT id, cache_revision AS revision FROM conversations").all() as Array<{ id: string; revision: number }>).map((row) => [row.id, row.revision]));
  return {
    sourceId: offlineSourceId(store), settings: store.getSettings(), agents: store.listAgents(),
    connections: store.listConnections(), models: store.listModels(),
    conversations: store.listConversations().map((conversation) => ({ ...conversation, cacheRevision: revisions.get(conversation.id)! }))
  };
}
