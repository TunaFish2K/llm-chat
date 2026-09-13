import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { ContainerEnvironments } from "./container-environments";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { createStore, seedModel, cleanupStores } from "./test-helpers";
import { executionEnvironmentSchema, type ContainerEngine } from "@llm-chat/contracts";
import { buildServerTools } from "./tools";

const selected = (process.env.LLM_CHAT_TEST_CONTAINER_ENGINES ?? "").split(",");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); cleanupStores(); });
for (const engine of ["docker", "podman"] as ContainerEngine[]) describe.skipIf(!selected.includes(engine))(engine, () => {
  async function fixture() {
    const store = createStore(); seedModel(store);
    const workspace = `${store.dataDir}/project with spaces, commas`;
    await mkdir(workspace);
    const agent = store.listAgents()[0]!;
    const config = executionEnvironmentSchema.parse({ type: "container", engine, image: process.env.LLM_CHAT_TEST_CONTAINER_IMAGE ?? "llm-chat-runtime:local" });
    if (config.type !== "container") throw new Error();
    store.updateAgent(agent.id, { execution: { ...store.getAgent(agent.id)!.execution, environment: config } });
    const conversation = store.createConversation({ agentId: agent.id, workspacePath: workspace });
    const generated = store.createMessageGeneration(conversation.id, "Container test");
    const record = store.getGenerationRecord(generated.generationId)!;
    const manager = new ContainerEnvironments(store);
    await manager.initialize();
    const tasks = new TaskManager(store, new EventHub(), manager);
    cleanups.push(async () => {
      await tasks.close();
      for (const env of manager.list(conversation.id)) await manager.stop(conversation.id, env.id, true);
      await manager.close();
    });
    const run = async (command: string, timeout = 20000, signal = new AbortController().signal) =>
      JSON.parse(await manager.execute(conversation.id, config, workspace, command, "/workdir", timeout, signal));
    return { manager, tasks, store, conversation, workspace, config, record, run };
  }
  it("shares the host network, maps file ownership, permits sudo and persists the environment", async () => {
    const { manager, conversation, workspace, run } = await fixture();
    const server = createServer((_req, response) => response.end("host-localhost-ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const port = (server.address() as { port: number }).port;
    await writeFile(`${workspace}/input.txt`, "host-file");
    const first = await run(`pwd; cat input.txt; printf from-container > output.txt; sudo sh -c 'printf installed > /opt/test-installed'; curl -fsS http://127.0.0.1:${port}`);
    expect(first.stdout).toContain("/workdir");
    expect(first.stdout).toContain("host-file");
    expect(first.stdout).toContain("host-localhost-ok");
    expect(await readFile(`${workspace}/output.txt`, "utf8")).toBe("from-container");
    expect((await stat(`${workspace}/output.txt`)).uid).toBe(process.getuid!());
    const env = manager.list(conversation.id)[0]!;
    await manager.stop(conversation.id, env.id);
    expect((await run("cat /opt/test-installed")).stdout).toBe("installed");
    expect(manager.list(conversation.id)[0]!.id).toBe(env.id);
    await manager.stop(conversation.id, env.id, true);
    expect((await run("test ! -e /opt/test-installed && cat output.txt")).stdout).toBe("from-container");
  }, 90000);

  it("cancels and times out container process groups without killing an unrelated command", async () => {
    const { run, workspace } = await fixture();
    await run("true");
    const controller = new AbortController();
    const running = run("echo ready > ready; sleep 20; touch leaked", 30000, controller.signal).catch(error => error);
    try {
      await expect.poll(async () => readFile(`${workspace}/ready`, "utf8").catch(() => ""), { timeout: 15000 }).toContain("ready");
      const unrelated = run("sleep 2; printf survivor");
      controller.abort();
      expect(await running).toMatchObject({ result: { cancelled: true } });
      expect((await unrelated).stdout).toBe("survivor");
    } finally { controller.abort(); await running; }
    await expect(run("sleep 20; touch timed-out", 300)).rejects.toMatchObject({ result: { timedOut: true } });
    expect((await run("test ! -e leaked && test ! -e timed-out && pgrep -f '^sleep 20$' || true")).stdout).toBe("");
  }, 90000);

  it.each(["pipe", "pty"] as const)("keeps %s task input, stop and environment switching tied to the container", async mode => {
    const { tasks, record, config, conversation, workspace, manager, run } = await fixture();
    const task = tasks.create({ conversationId: conversation.id, generationId: record.id, snapshot: record.agentSnapshot,
      command: "printf 'ready\\n'; read answer; printf 'got:%s\\n' \"$answer\"; sleep 60", mode,
      expectedDurationMs: null, hardTimeoutMs: 30000, workspacePath: workspace });
    await expect.poll(() => tasks.get(task.id)?.status, { timeout: 30000 }).toBe("running");
    await expect.poll(async () => (await tasks.read(task.id, 0)).text, { timeout: 15000 }).toContain("ready");
    tasks.resize(task.id, 80, 24);
    tasks.write(task.id, "hello\n", "test input");
    await expect.poll(async () => (await tasks.read(task.id, 0)).text, { timeout: 15000 }).toContain("got:hello");
    await manager.sweep(Date.now() + 3600000);
    expect(manager.list(conversation.id)[0]!.status).toBe("running");
    await expect(manager.prepare(conversation.id, { ...config, image: "another:local" }, workspace, "true", "/workdir")).rejects.toThrow("Another environment");
    tasks.stop(task.id, "test stop");
    await expect.poll(() => tasks.get(task.id)?.status, { timeout: 15000 }).toBe("stopped");
    expect((await run("pgrep -f '^sleep 60$' || true")).stdout).toBe("");
  }, 90000);

  it("makes workspace operations automatic without eagerly starting a container or changing global tools", async () => {
    const { store, manager, config, conversation, workspace } = await fixture();
    const tools = await buildServerTools(store, true, { environments: manager, environment: config, conversationId: conversation.id, workspacePath: workspace });
    const writer = tools.find(tool => tool.definition.name === "workspace_write_file")!;
    expect(writer.containerAutoApproval).toBe(true);
    await writer.execute({ path: "/workdir/new.txt", text: "hello" }, new AbortController().signal);
    expect(await readFile(`${workspace}/new.txt`, "utf8")).toBe("hello");
    expect(manager.list(conversation.id)).toEqual([]);
    expect(tools.some(tool => tool.definition.name === "workspace_shell_readonly")).toBe(false);
    expect(tools.find(tool => tool.definition.name === "image_generate")!.containerAutoApproval).toBeUndefined();
  }, 90000);

  it("stops tasks at shutdown and reuses the writable layer after service recovery", async () => {
    const { tasks, record, conversation, workspace, manager, run, store, config } = await fixture();
    await run("sudo sh -c 'printf retained > /opt/recovery-proof'");
    const task = tasks.create({ conversationId: conversation.id, generationId: record.id, snapshot: record.agentSnapshot,
      command: "printf ready; sleep 60", mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null, workspacePath: workspace });
    await expect.poll(async () => (await tasks.read(task.id, 0)).text, { timeout: 15000 }).toContain("ready");
    await tasks.close();
    await manager.close();
    expect(tasks.get(task.id)?.status).toBe("interrupted");
    const recovered = new ContainerEnvironments(store);
    cleanups.push(() => recovered.close());
    await recovered.initialize();
    expect(recovered.list(conversation.id)[0]!.status).toBe("stopped");
    const output = JSON.parse(await recovered.execute(conversation.id, config, workspace,
      "cat /opt/recovery-proof; pgrep -f '^sleep 60$' || true", "/workdir", 20000, new AbortController().signal));
    expect(output.stdout).toBe("retained");
  }, 90000);

  it("gives a fork an independent container layer while retaining the selected project", async () => {
    const { store, manager, conversation, config, workspace, run } = await fixture();
    await run("sudo sh -c 'printf original > /opt/fork-proof'; printf shared > project.txt");
    const fork = store.forkConversation(conversation.id, { mode: "continue", throughMessageId: null }).conversation;
    cleanups.push(async () => { for (const env of manager.list(fork.id)) await manager.stop(fork.id, env.id, true); });
    const output = JSON.parse(await manager.execute(fork.id, config, workspace,
      "test ! -e /opt/fork-proof && cat project.txt", "/workdir", 20000, new AbortController().signal));
    expect(output.stdout).toBe("shared");
    expect(manager.list(fork.id)[0]!.id).not.toBe(manager.list(conversation.id)[0]!.id);
  }, 90000);
});
