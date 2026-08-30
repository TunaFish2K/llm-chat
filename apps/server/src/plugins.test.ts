import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStores, createStore } from "./test-helpers";
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
      }, requiresApproval: input => input.value === "approve", execute: input => ({ echoed: input.value, configured: Boolean(api.config.token) }) });
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
    expect(JSON.stringify(manager.list())).not.toContain('"token":"secret"');
    manager.close();
  }, 20_000);
});
