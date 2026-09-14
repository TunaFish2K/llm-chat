import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "./events";
import { TaskManager } from "./background-tasks";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => { vi.unstubAllEnvs(); cleanupStores(); });

describe("TaskManager", () => {
  it("runs pipe tasks, exposes incremental output, and keeps audit reasons", async () => {
    const { store, record } = generation();
    const manager = new TaskManager(store, new EventHub());
    const task = manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot,
      command: "read line; printf 'got:%s' \"$line\"", mode: "pipe", expectedDurationMs: 50, hardTimeoutMs: 5_000
    });
    await until(() => manager.get(task.id)?.status === "running");
    const listeners = (manager as unknown as { listeners: Map<string, Set<() => void>> }).listeners;
    for (let i = 0; i < 30; i++) {
      await manager.wait(task.id, 0, 1, 0);
      expect(listeners.size).toBe(0);
    }
    const pending = manager.wait(task.id, 0, 120_000, 0);
    manager.write(task.id, "hello\n", "回答测试提示");
    await until(() => manager.get(task.id)?.status === "completed");
    const output = await manager.read(task.id, 0);
    await pending;
    expect(listeners.size).toBe(0);
    expect(output.text).toContain("got:hello");
    expect(output.cursor).toBeGreaterThan(0);
    expect(manager.eventsFor(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "write", reason: "回答测试提示" })
    ]));
    await manager.close();
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
    await manager.close();
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
    await manager.close();
  });

  it("escalates shutdown to SIGKILL and waits until a TERM-ignoring child is gone", async () => {
    const { store, record } = generation();
    const manager = new TaskManager(store, new EventHub());
    const task = manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot,
      command: "trap '' TERM; printf ready; while :; do sleep 1; done",
      mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null
    });
    await until(() => (manager.get(task.id)?.outputCursor ?? 0) > 0);
    const row = store.sqlite.prepare("SELECT pid FROM background_tasks WHERE id = ?").get(task.id) as { pid: number };

    const firstClose = manager.close();
    expect(manager.close()).toBe(firstClose);
    await firstClose;

    expect(manager.get(task.id)).toMatchObject({ status: "interrupted", error: "服务关闭" });
    expect((await manager.read(task.id, 0)).text).toContain("ready");
    expectProcessGone(row.pid);
    expect(() => manager.create({
      conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot,
      command: "printf late", mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null
    })).toThrow("Task manager is closing");
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

function expectProcessGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

it("validates stale task actions and stops queued tasks without starting a process", async () => {
  const { store, record } = generation(); const manager = new TaskManager(store, new EventHub());
  const input = { conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot, command: "printf should-not-run", mode: "pipe" as const, expectedDurationMs: null, hardTimeoutMs: null };
  try {
    expect(() => manager.create({ ...input, snapshot: { ...input.snapshot, workspacePath: null } })).toThrow("no workspace");
    await expect(manager.read("missing", 0)).rejects.toThrow("not found"); await expect(manager.wait("missing", 0, 1, 0)).rejects.toThrow("not found");
    expect(() => manager.write("missing", "x", "")).toThrow("reason is required"); expect(() => manager.write("missing", "x", "audit")).toThrow("not running");
    expect(() => manager.stop("missing", "")).toThrow("reason is required"); expect(() => manager.stop("missing", "audit")).toThrow("not found"); manager.resize("missing", 80, 24);
    const agent = store.getAgent(record.agentSnapshot.agentId!)!; store.updateAgent(agent.id, { execution: { ...agent.execution, maxBackgroundTasks: 0 } });
    const task = manager.create(input);
    expect(manager.hasNonterminalForAgent(agent.id)).toBe(true); expect(manager.hasNonterminalForConversation(record.conversationId)).toBe(true);
    expect(manager.runtimePrompt(record.conversationId)).toContain(task.id);
    expect((await manager.read(task.id, 0)).raw).toBe(""); expect(manager.stop(task.id, "cancel before start").status).toBe("stopped");
    expect(manager.stop(task.id, "again").status).toBe("stopped"); expect(manager.runtimePrompt(record.conversationId)).toBe("");
    expect((await manager.wait(task.id, 0, 500, 100)).task.status).toBe("stopped");
    const queued = manager.create(input); await manager.close(); expect(manager.get(queued.id)?.status).toBe("interrupted");
  } finally { await manager.close(); }
});

it("rotates large logs, reports cursor gaps and enforces bounded reads", async () => {
  const { store, record } = generation(); const manager = new TaskManager(store, new EventHub());
  try {
    const task = manager.create({ conversationId: record.conversationId, generationId: record.id,
      snapshot: { ...record.agentSnapshot, execution: { ...record.agentSnapshot.execution, taskLogLimitBytes: 1024 * 1024 } },
      command: `node -e 'process.stdout.write("x".repeat(2300000))'`, mode: "pipe", expectedDurationMs: null, hardTimeoutMs: 5000 });
    await until(() => manager.get(task.id)?.status === "completed");
    const result = await manager.read(task.id, 0, 1000000);
    expect(result.gap).toBe(true); expect(result.earliestCursor).toBeGreaterThan(0); expect(result.text).toHaveLength(32 * 1024);
    expect((await manager.read(task.id, result.cursor, 0)).raw).toBe("x");
    expect((await manager.read(task.id, 2300000)).raw).toBe("");
  } finally { await manager.close(); }
});

it("reports nonzero process exit and hard timeout as distinct terminal outcomes", async () => {
  const { store, record } = generation(); const manager = new TaskManager(store, new EventHub());
  const input = { conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot, mode: "pipe" as const, expectedDurationMs: 1, hardTimeoutMs: null };
  try {
    const failed = manager.create({ ...input, command: "printf stderr >&2; exit 7" });
    await until(() => manager.get(failed.id)?.status === "failed"); expect(manager.get(failed.id)).toMatchObject({ exitCode: 7, errorI18n: { key: "background.exit_code", params: { code: 7 } } });
    expect((await manager.read(failed.id, 0)).text).toContain("stderr");
    const timeout = manager.create({ ...input, command: "sleep 10", hardTimeoutMs: 50 });
    await until(() => manager.get(timeout.id)?.status === "timed_out"); expect(manager.eventsFor(timeout.id)).toContainEqual(expect.objectContaining({ type: "warning", reason: "达到硬超时" }));
    const container = manager.create({ ...input, command: "true", snapshot: { ...input.snapshot, execution: { ...input.snapshot.execution, environment: { type: "container", engine: "docker", image: "test", idleTimeoutMinutes: 15 } } } });
    await until(() => manager.get(container.id)?.status === "failed"); expect(manager.get(container.id)?.error).toBe("Container environment unavailable");
  } finally { await manager.close(); }
});

it("reports a missing shell executable", async () => {
  const { store, record } = generation(); const manager = new TaskManager(store, new EventHub());
  const input = { conversationId: record.conversationId, generationId: record.id, snapshot: record.agentSnapshot, command: "true", mode: "pipe" as const, expectedDurationMs: null, hardTimeoutMs: null };
  try {
    vi.stubEnv("SHELL", `${store.dataDir}/missing-shell`);
    const failed = manager.create(input); await until(() => manager.get(failed.id)?.status === "failed"); expect(manager.get(failed.id)?.error).toContain("ENOENT");
  } finally { await manager.close(); }
});
