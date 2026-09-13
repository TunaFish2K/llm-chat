import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./database";
import { ContainerEnvironments } from "./container-environments";
import type { EngineAdapter } from "./container-engine";
import { executionEnvironmentSchema, type ContainerEngine } from "@llm-chat/contracts";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { seedModel } from "./test-helpers";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "llm-chat-container-test-"));
  const store = new Store(join(dir, "db.sqlite"));
  const conversation = store.createConversation({ agentId: store.listAgents()[0]!.id });
  const calls: Array<{ engine: string; args: string[] }> = [];
  const containers = new Map<string, { running: boolean; owner: string }>();
  const network = await readlink("/proc/self/ns/net");
  const adapter = (engine: ContainerEngine): EngineAdapter => ({
    engine, command: args => ({ executable: engine, args }),
    probe: async () => ({ engine, available: true, version: "test", error: null }),
    run: vi.fn(async args => {
      calls.push({ engine, args });
      if (args[0] === "ps") return containers.has(args[3]!.slice(6, -1)) ? "container-id" : "";
      if (args[0] === "inspect") {
        const c = containers.get(args[1]!)!;
        return JSON.stringify([{ State: { Running: c.running }, Config: { Labels: { "fish.2kb.llm-chat.owner": c.owner } } }]);
      }
      if (args[0] === "image") return JSON.stringify([{ Id: "sha256:immutable", Config: { Labels: { "fish.2kb.llm-chat.runtime": "1" } } }]);
      if (args[0] === "create") containers.set(args[2]!, { running: false, owner: args[4]!.split("=")[1]! });
      if (args[0] === "start") containers.get(args[1]!)!.running = true;
      if (args[0] === "stop") containers.get(args.at(-1)!)!.running = false;
      if (args[0] === "rm") containers.delete(args[1]!);
      if (args.includes("readlink")) return network;
      return "";
    })
  });
  const engines = { docker: adapter("docker"), podman: adapter("podman") };
  const manager = new ContainerEnvironments(store, engines);
  cleanups.push(async () => { await manager.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const config = executionEnvironmentSchema.parse({ type: "container", engine: "docker" });
  if (config.type !== "container") throw new Error();
  return { manager, store, conversation, calls, containers, config, engines };
}

it("validates environment settings without changing old Agent defaults", () => {
  expect(executionEnvironmentSchema.parse({ type: "host" })).toEqual({ type: "host" });
  expect(executionEnvironmentSchema.parse({ type: "container", engine: "podman" })).toMatchObject({ image: "llm-chat-runtime:local", idleTimeoutMinutes: 15 });
  expect(executionEnvironmentSchema.safeParse({ type: "container", engine: "docker", image: "--privileged" }).success).toBe(false);
});

it("registers lazily and serializes concurrent first use with a pinned image", async () => {
  const { manager, conversation, calls, config } = await fixture();
  await manager.initialize();
  await manager.register(conversation.id, config, null);
  expect(calls).toHaveLength(0);
  const jobs = await Promise.all([1, 2].map(() => manager.prepare(conversation.id, config, null, "pwd", "/workdir")));
  expect(calls.filter(call => call.args[0] === "create")).toHaveLength(1);
  expect(calls.find(call => call.args[0] === "create")!.args).toContain("sha256:immutable");
  await expect(manager.stop(conversation.id, jobs[0]!.environmentId)).rejects.toThrow("active tools");
  jobs.forEach(job => job.release());
  await manager.sweep(Date.now() + 16 * 60_000);
  expect(manager.list(conversation.id)[0]!.status).toBe("stopped");
  const resumed = await manager.prepare(conversation.id, config, null, "pwd", "/workdir");
  resumed.release();
  expect(calls.filter(call => call.args[0] === "create")).toHaveLength(1);
});

it("preserves separate environments and prevents switching while a lease is active", async () => {
  const { manager, conversation, config, containers } = await fixture();
  const old = await manager.prepare(conversation.id, config, null, "pwd", "/workdir");
  const other = { ...config, engine: "podman" as const };
  await expect(manager.prepare(conversation.id, other, null, "pwd", "/workdir")).rejects.toThrow("Another environment");
  old.release();
  const next = await manager.prepare(conversation.id, other, null, "pwd", "/workdir");
  expect([...containers.values()].filter(c => c.running)).toHaveLength(1);
  next.release();
  const restored = await manager.prepare(conversation.id, config, null, "pwd", "/workdir");
  expect(restored.environmentId).toBe(old.environmentId);
  restored.release();
  expect(containers.size).toBe(2);
});

it("refuses a different network namespace and never leaves that container running", async () => {
  const { manager, conversation, config, engines, containers } = await fixture();
  const run = engines.docker.run;
  engines.docker.run = (args, input, timeout) => args.includes("readlink") ? Promise.resolve("net:[other]") : run(args, input, timeout);
  await expect(manager.prepare(conversation.id, config, null, "pwd", "/workdir")).rejects.toThrow("network namespace");
  expect([...containers.values()].some(c => c.running)).toBe(false);
  expect(manager.list(conversation.id)[0]!.status).toBe("error");
});

it("still stops an idle container after a concurrent preparation failure", async () => {
  const { manager, conversation, config, engines, containers } = await fixture();
  const active = await manager.prepare(conversation.id, config, null, "true", "/workdir");
  engines.docker.probe = async () => ({ engine: "docker", available: false, version: null, error: "Temporary engine failure" });
  await expect(manager.prepare(conversation.id, config, null, "true", "/workdir")).rejects.toThrow("Temporary engine failure");
  expect([...containers.values()].some(c => c.running)).toBe(true);
  active.release();
  await manager.sweep(Date.now() + 3600000);
  expect([...containers.values()].some(c => c.running)).toBe(false);
  expect(manager.list(conversation.id)[0]!.status).toBe("stopped");
});

it("recovers persisted containers on restart and cleans deleted conversations", async () => {
  const { manager, conversation, config, store, containers } = await fixture();
  const job = await manager.prepare(conversation.id, config, null, "pwd", "/workdir");
  job.release();
  await manager.initialize();
  expect([...containers.values()].some(c => c.running)).toBe(false);
  store.deleteConversation(conversation.id);
  await manager.cleanupDeleted();
  expect(containers.size).toBe(0);
  expect(manager.list(conversation.id)).toEqual([]);
});

it("blocks switching with an unstarted queued task and allows it after cancellation", async () => {
  const { manager, conversation, config, store, calls } = await fixture();
  seedModel(store);
  const agent = store.getAgent(conversation.agentId!)!;
  store.updateAgent(agent.id, { execution: { ...agent.execution, environment: config, maxBackgroundTasks: 0 } });
  const generated = store.createMessageGeneration(conversation.id, "queued task");
  const record = store.getGenerationRecord(generated.generationId)!;
  const tasks = new TaskManager(store, new EventHub(), manager);
  cleanups.push(() => tasks.close());
  const input = { conversationId: conversation.id, generationId: record.id, snapshot: record.agentSnapshot,
    command: "true", mode: "pipe" as const, expectedDurationMs: null, hardTimeoutMs: null };
  const queued = tasks.create(input);
  expect(queued.status).toBe("queued");
  expect(calls).toHaveLength(0);
  expect(manager.list(conversation.id)).toEqual([]);
  const active = await manager.prepare(conversation.id, config, null, "true", "/workdir");
  active.release();
  await manager.sweep(Date.now() + 3600000);
  expect(manager.list(conversation.id)[0]!.status).toBe("running");
  await expect(manager.stop(conversation.id, active.environmentId)).rejects.toThrow("active tools");
  const other = { ...config, engine: "podman" as const };
  expect(() => tasks.create({ ...input, snapshot: { ...record.agentSnapshot, execution: { ...record.agentSnapshot.execution, environment: other } } })).toThrow("Another environment");
  await expect(manager.prepare(conversation.id, other, null, "true", "/workdir")).rejects.toThrow("Another environment");
  await expect(manager.enterHost(conversation.id)).rejects.toThrow("Another environment");
  tasks.stop(queued.id, "cancel queued task");
  const job = await manager.prepare(conversation.id, other, null, "true", "/workdir");
  job.release();
});
