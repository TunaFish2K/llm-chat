import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub } from "./events";
import { TaskManager } from "./background-tasks";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => cleanupStores());

describe("TaskManager", () => {
  it("runs pipe tasks, exposes incremental output, and keeps audit reasons", async () => {
    const { store, record } = generation();
    const manager = new TaskManager(store, new EventHub());
    const task = manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot,
      command: "read line; printf 'got:%s' \"$line\"", mode: "pipe", expectedDurationMs: 50, hardTimeoutMs: 5_000
    });
    await until(() => manager.get(task.id)?.status === "running");
    manager.write(task.id, "hello\n", "回答测试提示");
    await until(() => manager.get(task.id)?.status === "completed");
    const output = await manager.read(task.id, 0);
    expect(output.text).toContain("got:hello");
    expect(output.cursor).toBeGreaterThan(0);
    expect(manager.eventsFor(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "write", reason: "回答测试提示" })
    ]));
    manager.close();
  });

  it("runs PTY tasks and returns both raw output and a screen projection", async () => {
    const { store, record } = generation();
    const manager = new TaskManager(store, new EventHub());
    const task = manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot,
      command: "printf '\\033[31mred\\033[0m\\n'", mode: "pty", expectedDurationMs: null, hardTimeoutMs: null
    });
    await until(() => manager.get(task.id)?.status === "completed");
    const output = await manager.read(task.id, 0);
    expect(output.raw).toContain("red");
    expect(output.screen).toContain("red");
    manager.close();
  });

  it("queues at a zero Agent quota and starts after a live policy update", async () => {
    const { store, record } = generation();
    const agent = store.getAgent(record.agentSnapshot.agentId!)!;
    store.updateAgent(agent.id, { execution: { ...agent.execution, maxBackgroundTasks: 0 } });
    const manager = new TaskManager(store, new EventHub());
    const task = manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: { ...record.agentSnapshot, execution: { ...record.agentSnapshot.execution, maxBackgroundTasks: 0 } },
      command: "printf queued", mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.get(task.id)?.status).toBe("queued");
    const updated = store.getAgent(agent.id)!;
    store.updateAgent(agent.id, { execution: { ...updated.execution, maxBackgroundTasks: 1 } });
    manager.notifyAgentPolicyChanged(agent.id);
    await until(() => manager.get(task.id)?.status === "completed");
    expect((await manager.read(task.id, 0)).text).toContain("queued");
    manager.close();
  });
});

function generation() {
  const store = createStore();
  seedModel(store);
  const workspace = `${store.dataDir}/workspace`;
  writeFileSync(`${workspace}/marker`, "ok");
  const conversation = store.createConversation({ systemPrompt: "" });
  store.updateConversation(conversation.id, { workspacePath: workspace });
  const created = store.createMessageGeneration(conversation.id, "run");
  return { store, record: store.getGenerationRecord(created.generationId)! };
}

async function until(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}
