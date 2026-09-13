import { afterEach, expect, it } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { offlineManifest, offlineSourceId } from "./offline-history";
import { Store } from "./database";
afterEach(cleanupStores);

it("tracks streaming content, usage, tools and attachments independently of conversation timestamps", () => {
  const store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const generation = store.createMessageGeneration(conversation.id, "offline history");
  const id = generation.generationId;
  const revision = () => offlineManifest(store).conversations.find((item) => item.id === conversation.id)!.cacheRevision;
  let prior = revision();
  const updatedAt = store.getConversation(conversation.id)!.updatedAt;
  store.sqlite.prepare("INSERT INTO generation_blocks(id,generation_id,block_index,type,content,complete) VALUES (?,?,0,'text','first',0)").run("offline-block", id);
  expect(revision()).toBeGreaterThan(prior); prior = revision();
  store.sqlite.prepare("UPDATE generation_blocks SET content='changed' WHERE id='offline-block'").run();
  expect(revision()).toBeGreaterThan(prior); prior = revision();
  store.sqlite.prepare("UPDATE generations SET usage_json='{}', status='completed' WHERE id=?").run(id);
  expect(revision()).toBeGreaterThan(prior); prior = revision();
  store.sqlite.prepare("INSERT INTO generation_tool_calls(id,generation_id,call_index,name) VALUES ('offline-tool',?,0,'example')").run(id);
  expect(revision()).toBeGreaterThan(prior); prior = revision();
  store.sqlite.prepare("UPDATE generation_tool_calls SET output='answer', presentation_json='{}' WHERE id='offline-tool'").run();
  expect(revision()).toBeGreaterThan(prior);
  expect(store.getConversation(conversation.id)!.updatedAt).toBe(updatedAt);
  expect(offlineSourceId(store)).toBe(offlineSourceId(store));
});

it("migrates schema 38 and retains the source identity across restarts", () => {
  const store = createStore();
  const path = String((store.sqlite.prepare("PRAGMA database_list").get() as { file: string }).file);
  for (const { name } of store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'offline_%'").all() as { name: string }[]) store.sqlite.exec(`DROP TRIGGER ${name}`);
  store.sqlite.exec("ALTER TABLE app_settings DROP COLUMN offline_source_id; ALTER TABLE conversations DROP COLUMN cache_revision; PRAGMA user_version=38");
  store.close();
  const migrated = new Store(path);
  const id = offlineSourceId(migrated);
  expect(id).toMatch(/^[\da-f-]{36}$/);
  expect(migrated.sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 44 });
  migrated.close();
  const reopened = new Store(path);
  expect(offlineSourceId(reopened)).toBe(id);
  reopened.close();
});
