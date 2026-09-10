import { afterEach, expect, it, vi } from "vitest";
import { builtinToolFormatters, formatTool, legacyToolPresentation, normalizeToolMarkdown } from "./tool-presentation";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { Store } from "./database";

afterEach(() => { vi.useRealTimers(); cleanupStores(); });
it("formats shell streams, search links and code while preserving raw records", () => {
  const shell = legacyToolPresentation("workspace_shell", '{"command":"printf hi"}', '{"stdout":"hi","stderr":"","exitCode":0}', null)!;
  expect(shell.arguments?.detail).toContain("```bash\nprintf hi");
  expect(shell.result?.detail).toContain("**stdout**");
  const readonly = legacyToolPresentation("workspace_shell_readonly", '{"command":"cat example.txt | sort"}', '{"stdout":"example","stderr":"","exitCode":0}', null)!;
  expect(readonly.arguments?.detail).toContain("```bash\ncat example.txt | sort");
  expect(readonly.result?.detail).toContain("example");
  const search = legacyToolPresentation("search_web", '{"query":"hello"}', '[{"title":"Result","url":"https://example.com","snippet":"Hello"}]', null)!;
  expect(search.result?.detail).toContain("<https://example.com>");
  expect(builtinToolFormatters("plugin__sample__echo")).toBeUndefined();
  expect(legacyToolPresentation("workspace_shell", "broken", "", null)).toBeUndefined();
});
it("limits untrusted formatting and falls back on failure or timeout", async () => {
  expect(normalizeToolMarkdown({ summary: 123 })).toBeUndefined();
  const limited = normalizeToolMarkdown({ summary: "字".repeat(2000), detail: "字".repeat(50000) })!;
  expect(Array.from(limited.summary!).length).toBeLessThanOrEqual(512);
  expect(Buffer.byteLength(limited.detail!)).toBeLessThanOrEqual(65536);
  await expect(formatTool(() => { throw Error("broken"); }, {})).resolves.toBeUndefined();
  vi.useFakeTimers();
  const pending = formatTool(() => new Promise(() => {}), {});
  await vi.advanceTimersByTimeAsync(1001);
  await expect(pending).resolves.toBeUndefined();
});
it("migrates legacy history, snapshots new presentations, and clones them without altering provider content", () => {
  let store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const turn = store.createMessageGeneration(conversation.id, "hello");
  const call = store.upsertToolCall(turn.generationId, { id: "legacy-call", name: "workspace_shell", arguments: '{"command":"echo hi"}' }, 0, 0, false);
  const presentation = { arguments: { summary: "CUSTOM MARKDOWN", detail: "## command" }, result: { detail: "## result" } };
  store.updateToolCall(call.id, { output: "RAW OUTPUT", presentation, approvalState: "completed" });
  store.finishGeneration(turn.generationId, "completed", {});
  expect(JSON.stringify(store.currentGenerationMessages(turn.generationId))).not.toContain("CUSTOM MARKDOWN");
  const fork = store.forkConversation(conversation.id, { mode: "continue", throughMessageId: turn.assistantMessageId });
  expect(store.listMessages(fork.conversation.id).flatMap((m) => m.generations).flatMap((g) => g.toolCalls)[0]?.presentation).toEqual(presentation);
  const dir = store.dataDir; store.close(); store = new Store(`${dir}/test.sqlite`);
  expect(store.getToolCall(call.id)?.presentation).toEqual(presentation);
  store.sqlite.exec("ALTER TABLE generation_tool_calls DROP COLUMN presentation_json; PRAGMA user_version = 36");
  store.close(); store = new Store(`${dir}/test.sqlite`);
  expect(store.getToolCall(call.id)?.presentation?.arguments?.summary).toBe("echo hi");
  expect(store.getToolCall(call.id)?.output).toBe("RAW OUTPUT");
  store.close();
});
