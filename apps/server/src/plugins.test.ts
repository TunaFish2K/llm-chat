import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { EventHub } from "./events";
import { PluginManager } from "./plugins";

afterEach(() => cleanupStores());

describe("PluginManager", () => {
  it("installs a content-addressed ESM plugin and executes it in a child process", async () => {
    const store = createStore();
    const source = resolve(store.dataDir, "source-plugin");
    mkdirSync(source);
    writeFileSync(resolve(source, "plugin.json"), JSON.stringify({
      id: "sample", name: "Sample", version: "1.0.0", apiVersion: 1, entry: "index.mjs",
      description: "sample plugin", secretFields: ["token"]
    }));
    writeFileSync(resolve(source, "index.mjs"), `export function register(api) {
      api.registerTool({ name: "echo", description: "echo", inputSchema: {
        type: "object", properties: { value: { type: "string" } }, required: ["value"]
      }, formatArguments: input => ({ summary: input.value, detail: "**argument**" }),
      formatResult: ({ output }) => ({ summary: "done", detail: output }), requiresApproval: input => input.value === "approve", execute: input => ({ echoed: input.value, configured: Boolean(api.config.token) }) });
    }`);
    const manager = new PluginManager(store, new EventHub());
    const installed = await manager.install(source);
    expect(installed).toMatchObject({ id: "sample", state: "loaded", sourcePath: source });
    expect(installed.revision).toHaveLength(24);
    manager.configure("sample", {}, { token: "secret" });
    await manager.reload("sample");
    const tool = (await manager.tools()).find((item) => item.definition.name === "plugin__sample__echo")!;
    await expect(tool.requiresApproval({ value: "approve" })).resolves.toBe(true);
    await expect(tool.execute({ value: "hello" }, new AbortController().signal)).resolves.toBe('{"echoed":"hello","configured":true}');
    await expect(tool.formatArguments!({ value: "hello" })).resolves.toMatchObject({ summary: "hello" });
    await expect(tool.formatResult!({ input: {}, output: "raw result", error: null })).resolves.toMatchObject({ detail: "raw result" });
    expect(JSON.stringify(manager.list())).not.toContain('"token":"secret"');
    manager.close();
  }, 20_000);
});

function sourcePlugin(store: ReturnType<typeof createStore>, code: string, extra: Record<string, unknown> = {}) {
  const source = resolve(store.dataDir, "plugin-source"); mkdirSync(source);
  writeFileSync(resolve(source, "plugin.json"), JSON.stringify({ id: "cases", name: "Cases", version: "1", apiVersion: 1, entry: "index.mjs", ...extra }));
  writeFileSync(resolve(source, "index.mjs"), code);
  return source;
}
const echoPlugin = `export function register(api) { api.registerTool({ name: "echo", description: "echo", inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } }, requiresApproval: false, execute: input => input.value }); }`;

it("validates public configuration, protects secrets and retains configuration on reload", async () => {
  const store = createStore(); const manager = new PluginManager(store, new EventHub());
  const source = sourcePlugin(store, echoPlugin, { configSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] }, secretFields: ["token"] });
  try {
    const first = await manager.install(source); expect(await manager.install(source)).toMatchObject({ revision: first.revision, installedAt: first.installedAt });
    expect(() => manager.configure("missing", {}, {})).toThrow("not found");
    expect(() => manager.configure("cases", { count: "wrong" }, {})).toThrow();
    manager.configure("cases", { count: 1 }, { token: "secret", ignored: "bad" });
    manager.configurePublic("cases", { count: 2 });
    await manager.reload("cases");
    expect(manager.list()[0]).toMatchObject({ config: { count: 2 }, configuredSecretFields: ["token"] });
    expect(String(store.sqlite.prepare("SELECT secrets_json FROM plugin_installations").get()!.secrets_json)).not.toContain("ignored");
    const tool = (await manager.tools())[0]!;
    expect(await tool.requiresApproval({ value: "x" })).toBe(false);
    await expect(tool.execute({ value: 3 }, new AbortController().signal)).rejects.toThrow("Invalid tool arguments");
    expect(await tool.execute({ value: "ok" }, new AbortController().signal)).toBe("ok");
    expect(manager.unload("cases").state).toBe("unloaded"); expect(await manager.tools()).toEqual([]); expect(manager.activeRevisions()).toEqual({});
    await manager.reload("cases"); await manager.remove("cases"); expect(manager.list()).toEqual([]);
    await expect(manager.reload("missing")).rejects.toThrow("not found"); await expect(manager.remove("missing")).rejects.toThrow("not found"); expect(() => manager.unload("missing")).toThrow("not found");
  } finally { manager.close(); }
});

it("rejects unsafe source layouts and malformed plugin packages", async () => {
  const store = createStore(); const manager = new PluginManager(store, new EventHub());
  const source = sourcePlugin(store, echoPlugin);
  try {
    await expect(manager.install(resolve(source, "index.mjs"))).rejects.toThrow("directory");
    writeFileSync(resolve(source, "package.json"), "{"); await expect(manager.install(source)).rejects.toThrow();
    writeFileSync(resolve(source, "package.json"), "{}");
    symlinkSync(resolve(source, "index.mjs"), resolve(source, "linked.mjs")); await expect(manager.install(source)).rejects.toThrow("symbolic links");
  } finally { manager.close(); }
});

it.each(["../escape.mjs", ".", "directory", "missing.mjs"])("rejects unusable plugin entry %s", async entry => {
  const store = createStore(); const manager = new PluginManager(store, new EventHub());
  const source = sourcePlugin(store, echoPlugin, { entry }); mkdirSync(resolve(source, "directory"));
  try { await expect(manager.install(source)).rejects.toThrow(); expect(manager.list()).toEqual([]); }
  finally { manager.close(); }
});

it.each([
  "export function register() {}",
  "export const value = 1;",
  "export function register() { throw new Error('registration failed'); }"
])("reports registration failure without activating a revision", async code => {
  const store = createStore(); const manager = new PluginManager(store, new EventHub()); const source = sourcePlugin(store, code);
  try { await expect(manager.install(source)).rejects.toThrow(); expect(manager.activeRevisions()).toEqual({}); }
  finally { manager.close(); }
});

it("retains a pinned revision while edits mark a plugin pending and a bad reload fails", async () => {
  const store = createStore(); seedModel(store); const manager = new PluginManager(store, new EventHub());
  const source = sourcePlugin(store, echoPlugin); const conversation = store.createConversation({ systemPrompt: "" });
  try {
    const installed = await manager.install(source);
    const started = store.createMessageGeneration(conversation.id, "use plugin");
    const record = store.getGenerationRecord(started.generationId)!;
    record.agentSnapshot.toolRevisions = { cases: installed.revision };
    store.sqlite.prepare("UPDATE generations SET agent_snapshot_json = ? WHERE id = ?").run(JSON.stringify(record.agentSnapshot), started.generationId);
    await expect(manager.remove("cases")).rejects.toThrow("pinned");
    writeFileSync(resolve(source, "index.mjs"), "export const broken = true;");
    await vi.waitFor(() => expect(manager.list()[0]?.state).toBe("pending-reload"));
    await expect(manager.reload("cases")).rejects.toThrow(); expect(manager.list()[0]).toMatchObject({ state: "error", revision: installed.revision });
    const pinned = await manager.tools(record); expect(await pinned[0]!.execute({ value: "old" }, new AbortController().signal)).toBe("old");
    store.finishGeneration(started.generationId, "stopped", {}); await manager.remove("cases");
  } finally { manager.close(); }
});

it("restarts a failing tool host once and reports persistent execution errors", async () => {
  const store = createStore(); const manager = new PluginManager(store, new EventHub());
  const source = sourcePlugin(store, `export function register(api) { api.registerTool({ name: "fail", description: "fail", inputSchema: { type: "object" }, requiresApproval: true, execute: () => { throw new Error("provider unavailable"); } }); }`);
  try {
    await manager.install(source); const tool = (await manager.tools())[0]!; expect(await tool.requiresApproval({})).toBe(true);
    await expect(tool.execute({}, new AbortController().signal)).rejects.toThrow("provider unavailable");
    expect(manager.list()[0]).toMatchObject({ state: "error", error: expect.stringContaining("provider unavailable") });
  } finally { manager.close(); }
});
