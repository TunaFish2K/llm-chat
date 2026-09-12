import { afterEach, describe, expect, it } from "vitest";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { buildServerTools, type ToolExecutionContext } from "./tools";

afterEach(() => cleanupStores());

describe("generic background tools", () => {
  it.each(["pipe", "pty"])("retains interactive %s tasks, output cursors, and audit reasons", async (mode) => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "run a command");
    const record = store.getGenerationRecord(created.generationId)!;
    const context: ToolExecutionContext = {
      conversationId: conversation.id, generationId: record.id, toolCallId: "test-call", snapshot: record.agentSnapshot
    };
    const manager = new TaskManager(store, new EventHub());
    try {
      const tools = await buildServerTools(store, false, { taskManager: manager });
      const get = (name: string) => tools.find((item) => item.definition.name === name)!;
      const run = async (name: string, input: Record<string, unknown>, owner = context, signal = new AbortController().signal) =>
        JSON.parse(await get(name).execute(input, signal, owner));
      expect(tools.some((item) => item.definition.name.startsWith("codex_"))).toBe(false);
      expect(get("background_start").requiresApproval({})).toBe(true);
      expect(get("background_write").requiresApproval({})).toBe(true);
      expect(get("background_stop").requiresApproval({})).toBe(true);
      expect(get("background_read").requiresApproval({})).toBe(false);
      await expect(get("background_start").execute({ command: "true" }, new AbortController().signal)).rejects.toThrow("context is required");

      const task = await run("background_start", {
        command: "printf ready; read line; printf 'got:%s' \"$line\"; read again", mode,
        expected_duration_seconds: 1, hard_timeout_seconds: 10
      });
      expect(task).toMatchObject({ mode, expectedDurationMs: 1000, hardTimeoutMs: 10000 });
      await expect.poll(() => manager.get(task.id)?.outputCursor).toBeGreaterThan(0);
      const first = await run("background_read", { task_id: task.id });
      expect(first.text).toContain("ready");
      if (mode === "pty") expect(first.screen).toContain("ready");
      expect(await run("background_list", {})).toEqual([expect.objectContaining({ id: task.id })]);
      const foreign = { ...context, conversationId: "other-conversation" };
      expect(await run("background_list", {}, foreign)).toEqual([]);
      for (const name of ["background_status", "background_read", "background_wait", "background_write", "background_stop"]) {
        await expect(run(name, { task_id: task.id, data: "bad\n", reason: "test" }, foreign)).rejects.toThrow("another conversation");
        await expect(run(name, { task_id: "missing" })).rejects.toThrow("not found");
      }

      const controller = new AbortController();
      const waiting = run("background_wait", { task_id: task.id, cursor: first.cursor, timeout_seconds: 1 }, context, controller.signal);
      controller.abort(new Error("cancel wait"));
      await expect(waiting).rejects.toThrow("cancel wait");
      expect(await run("background_status", { task_id: task.id })).toMatchObject({ status: "running" });
      await expect(run("background_write", { task_id: task.id, data: "hello\n", reason: "" })).rejects.toThrow("reason is required");
      await run("background_write", { task_id: task.id, data: "hello\n", reason: "回答交互提示" });
      const next = await run("background_wait", { task_id: task.id, cursor: first.cursor, timeout_seconds: 1, quiet_period_ms: 20 });
      expect(next.text).toContain("got:hello");
      expect(next.cursor).toBeGreaterThan(first.cursor);
      await expect(run("background_stop", { task_id: task.id, reason: "" })).rejects.toThrow("reason is required");
      await run("background_stop", { task_id: task.id, reason: "任务已完成" });
      expect(manager.eventsFor(task.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "write", reason: "回答交互提示" }),
        expect.objectContaining({ type: "stop", reason: "任务已完成" })
      ]));
    } finally {
      await manager.close();
      store.close();
    }
  });
});
