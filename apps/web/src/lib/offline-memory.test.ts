import "fake-indexeddb/auto";
import type { OfflineConversationDto, OfflineManifestDto } from "@llm-chat/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { makeConversation, makeMessage, makeSettings } from "../../test/fixtures";
import { deleteOfflineConversation, iterateOfflineConversations, offlineConversationIndex, offlineRead, offlineWrite, putOfflineConversation, resetOfflineDb } from "./offline-db";
import { offlineRequest } from "./offline-history";

beforeEach(async () => { await resetOfflineDb({ epoch: "probe", sourceId: "source", enabled: true, authorized: true }); });
function snapshot(id: string): OfflineConversationDto {
  return { sourceId: "source", revision: 1, conversation: makeConversation({ id, title: `History ${id}` }),
    messages: [makeMessage({ id: `m-${id}`, role: "user", text: `${id} needle ${"x".repeat(20_000)}`, generations: [] })] } as OfflineConversationDto;
}

it("migrates legacy records one at a time and stores lightweight size/image metadata", async () => {
  const records = Array.from({ length: 60 }, (_, index) => snapshot(String(index).padStart(3, "0")));
  await offlineWrite("probe", (tx) => { for (const record of records) tx.objectStore("conversations").put(record); });
  const all = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => { throw new Error("Do not load full history"); });
  const entries = await offlineConversationIndex();
  expect(entries).toHaveLength(60);
  expect(entries.every((entry) => !Reflect.has(entry, "messages") && entry.bytes > 20_000)).toBe(true);
  expect(await offlineRead("meta", "conversation:000")).toMatchObject({ id: "000", bytes: entries[0]!.bytes });
  const record = { ...records[0]!, revision: 2, messages: [] };
  await offlineWrite("probe", (tx) => { putOfflineConversation(tx, record); deleteOfflineConversation(tx, "001"); });
  expect(await offlineRead("meta", "conversation:001")).toBeUndefined();
  expect(await offlineRead("meta", "conversation:000")).toMatchObject({ revision: 2, bytes: new Blob([JSON.stringify(record)]).size });
  expect(await offlineWrite("stale-epoch", (tx) => putOfflineConversation(tx, records[0]!))).toBe(false);
  all.mockRestore();
});

it("searches complete offline history without materializing all conversations", async () => {
  const records = Array.from({ length: 60 }, (_, index) => snapshot(String(index).padStart(3, "0")));
  const manifest = { sourceId: "source", settings: makeSettings(), agents: [], connections: [], models: [], conversations: records.map((record) => record.conversation) } as unknown as OfflineManifestDto;
  await offlineWrite("probe", (tx) => {
    tx.objectStore("meta").put(manifest, "manifest");
    for (const record of records) putOfflineConversation(tx, record);
  });
  const all = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => { throw new Error("Do not load full history"); });
  const results = await offlineRequest("/api/conversations/search?query=059%20needle") as Array<{ conversationId: string }>;
  expect(results.map((item) => item.conversationId)).toEqual(["059"]);
  let count = 0;
  for await (const record of iterateOfflineConversations()) { expect(record.messages).toHaveLength(1); count++; }
  expect(count).toBe(60); all.mockRestore();
});
