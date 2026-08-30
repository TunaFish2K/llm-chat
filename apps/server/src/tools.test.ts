import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStores, createStore } from "./test-helpers";
import { buildServerTools, toolSystemPrompt } from "./tools";

afterEach(cleanupStores);

describe("server tools", () => {
  it("confines workspace reads and writes to the server workspace", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    const write = tools.find((item) => item.definition.name === "workspace_write_file")!;
    const read = tools.find((item) => item.definition.name === "workspace_read_file")!;
    expect(write.requiresApproval({ path: "/workspace/note.txt" })).toBe(true);
    await write.execute({ path: "/workspace/note.txt", text: "hello" }, new AbortController().signal);
    await expect(read.execute({ path: "/workspace/note.txt" }, new AbortController().signal)).resolves.toContain("hello");
    await expect(read.execute({ path: "/workspace/../outside.txt" }, new AbortController().signal)).rejects.toThrow(/workspace/);
    store.close();
  });

  it("blocks loopback URL fetching before making a request", async () => {
    const store = createStore();
    const fetchTool = (await buildServerTools(store)).find((item) => item.definition.name === "fetch_url")!;
    await expect(fetchTool.execute({ url: "http://127.0.0.1/private" }, new AbortController().signal)).rejects.toThrow(/blocked/);
    store.close();
  });

  it("runs JavaScript without exposing Node globals", async () => {
    const store = createStore();
    const javascript = (await buildServerTools(store)).find((item) => item.definition.name === "eval_javascript")!;
    await expect(javascript.execute({ code: "1 + 2" }, new AbortController().signal)).resolves.toContain('"result":3');
    await expect(javascript.execute({ code: "typeof process" }, new AbortController().signal)).resolves.toContain('"undefined"');
    store.close();
  });

  it("loads skills and injects durable memories from server storage", async () => {
    const store = createStore();
    const skillDir = join(store.dataDir, "skills", "writer");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: writer\ndescription: Write clearly\n---\nUse short sentences.\n");
    store.createMemory("User prefers Chinese.");
    const skill = (await buildServerTools(store)).find((item) => item.definition.name === "use_skill")!;
    await expect(skill.execute({ name: "writer" }, new AbortController().signal)).resolves.toContain("Use short sentences");
    expect(toolSystemPrompt(store)).toContain("User prefers Chinese.");
    store.close();
  });
});
