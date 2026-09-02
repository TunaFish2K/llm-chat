import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { ImageService } from "./images";
import { buildServerTools, persistLargeToolOutput, type ServerTool, toolCatalog, toolSystemPrompt } from "./tools";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanupStores();
});

const signal = () => new AbortController().signal;
const tool = (tools: ServerTool[], name: string) => tools.find((item) => item.definition.name === name)!;

describe("server tool catalog", () => {
  it("reports enablement, availability, schemas, and approval requirements", async () => {
    const store = createStore();
    store.updateToolSettings({ enabled: { get_time_info: false }, workspaceShellEnabled: false });
    const enabled = await buildServerTools(store);
    expect(enabled.some((entry) => entry.definition.name === "get_time_info")).toBe(true);
    expect(tool(enabled, "search_web").available).toBe(false);
    expect(tool(enabled, "workspace_shell").available).toBe(true);
    expect(tool(enabled, "workspace_shell").requiresApproval({ command: "pwd" })).toBe(true);
    expect(tool(enabled, "workspace_write_file").definition.inputSchema).toMatchObject({
      type: "object", required: ["path", "text"]
    });
    expect(tool(enabled, "workspace_write_file").definition.description).toContain("relative to the conversation workspace root");
    expect(tool(enabled, "workspace_write_file").definition.inputSchema.properties).toMatchObject({
      path: { description: expect.stringContaining("Use . for the root") }
    });
    expect(tool(enabled, "workspace_shell").definition.inputSchema.properties).toMatchObject({
      command: { description: expect.stringContaining("relative to the conversation workspace root") },
      cwd: { description: expect.stringContaining("Use . for the root") }
    });
    const withoutWorkspace = await buildServerTools(store, false, { workspacePath: null });
    expect(tool(withoutWorkspace, "workspace_read_file").available).toBe(false);
    expect(tool(withoutWorkspace, "workspace_shell").available).toBe(false);

    const catalog = await toolCatalog(store);
    expect(catalog.find((entry) => entry.name === "get_time_info")).toBeTruthy();
    expect(catalog.find((entry) => entry.name === "eval_javascript")).toMatchObject({
      available: true, requiresApproval: true, category: "local"
    });
    expect(catalog.find((entry) => entry.name === "memory_tool")).toMatchObject({ requiresApproval: false });
    store.close();
  });

  it("validates required string arguments and clamps numeric limits", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    await expect(tool(tools, "workspace_read_file").execute({}, signal())).rejects.toThrow("path is required");
    await expect(tool(tools, "conversation_search").execute({ query: 3 }, signal())).rejects.toThrow("query is required");
    await expect(tool(tools, "recent_chats").execute({ limit: -10 }, signal())).resolves.toBe("[]");
    await expect(tool(tools, "memory_tool").execute({ action: "unknown" }, signal())).rejects.toThrow("Unknown memory action");
    expect(tool(tools, "memory_tool").requiresApproval({ action: "delete" })).toBe(true);
    store.close();
  });
});

describe("workspace tools", () => {
  it("publishes a workspace image as an immutable tool artifact", async () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ systemPrompt: "" });
    const created = store.createMessageGeneration(conversation.id, "show image");
    const call = store.upsertToolCall(
      created.generationId,
      { id: "publish-call", name: "workspace_publish_image", arguments: '{"path":"screen.png"}' },
      0,
      0,
      false
    );
    const workspace = join(store.dataDir, "workspace");
    writeFileSync(join(workspace, "screen.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const images = new ImageService(store);
    await images.initialize();
    const tools = await buildServerTools(store, false, { imageService: images });

    const result = JSON.parse(await tool(tools, "workspace_publish_image").execute(
      { path: "screen.png", alt: "machine screen" },
      signal(),
      {
        conversationId: conversation.id,
        generationId: created.generationId,
        toolCallId: call.id,
        snapshot: store.getGenerationRecord(created.generationId)!.agentSnapshot
      }
    ));
    expect(result.markdown).toBe(`![machine screen](${result.asset.url})`);
    expect(result.asset.url).toMatch(/^\/api\/images\/[0-9a-f-]+\?v=[a-f0-9]{64}$/);
    expect(store.getToolCall(call.id)?.artifacts).toEqual([expect.objectContaining({ id: result.asset.id })]);
    await expect(tool(tools, "workspace_publish_image").execute(
      { path: "../outside.png" },
      signal(),
      {
        conversationId: conversation.id,
        generationId: created.generationId,
        toolCallId: call.id,
        snapshot: store.getGenerationRecord(created.generationId)!.agentSnapshot
      }
    )).rejects.toThrow("相对工作区");
  });

  it("lists, reads, writes, and enforces overwrite rules", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    const write = tool(tools, "workspace_write_file");
    const read = tool(tools, "workspace_read_file");
    await write.execute({ path: "/workspace/docs/note.txt", text: "hello" }, signal());
    expect(JSON.parse(await read.execute({ path: "docs/note.txt" }, signal()))).toEqual({
      path: "docs/note.txt", text: "hello"
    });
    await expect(write.execute({ path: "docs/note.txt", text: "no", overwrite: false }, signal()))
      .rejects.toThrow("already exists");
    await write.execute({ path: "docs/note.txt", text: "updated", overwrite: true }, signal());
    const listed = JSON.parse(await tool(tools, "workspace_list").execute({ path: "/workspace", recursive: true }, signal()));
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs", type: "directory" }),
      expect.objectContaining({ path: "docs/note.txt", type: "file" })
    ]));
    store.close();
  });

  it("returns workspace-relative paths that shell commands can use and represents the root as .", async () => {
    const store = createStore();
    store.updateToolSettings({ workspaceShellEnabled: true });
    const tools = await buildServerTools(store);
    const written = JSON.parse(await tool(tools, "workspace_write_file").execute({
      path: "llm-chat/README.md", text: "workspace relative\n"
    }, signal()));
    expect(written.path).toBe("llm-chat/README.md");
    expect(JSON.parse(await tool(tools, "workspace_read_file").execute({ path: written.path }, signal())))
      .toEqual({ path: "llm-chat/README.md", text: "workspace relative\n" });
    expect(JSON.parse(await tool(tools, "workspace_glob").execute({ pattern: "." }, signal()))).toEqual(["."]);
    expect(JSON.parse(await tool(tools, "workspace_list").execute({ path: "." }, signal())))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "llm-chat", type: "directory" })]));
    const shellResult = JSON.parse(await tool(tools, "workspace_shell").execute({
      command: `cat ${written.path}`, cwd: "."
    }, signal()));
    expect(shellResult).toMatchObject({ exitCode: 0, stdout: "workspace relative\n" });
    expect(JSON.stringify({ written, shellResult })).not.toContain(store.dataDir);
    store.close();
  });

  it("accepts legacy /workspace inputs across file, search, and shell tools", async () => {
    const store = createStore();
    store.updateToolSettings({ workspaceShellEnabled: true });
    const tools = await buildServerTools(store);
    await tool(tools, "workspace_write_file").execute({ path: "/workspace/project/file.txt", text: "legacy" }, signal());
    expect(JSON.parse(await tool(tools, "workspace_read_file").execute({ path: "/workspace/project/file.txt" }, signal())))
      .toMatchObject({ path: "project/file.txt", text: "legacy" });
    expect(JSON.parse(await tool(tools, "workspace_glob").execute({ pattern: "/workspace/project/*.txt" }, signal())))
      .toEqual(["project/file.txt"]);
    expect(JSON.parse(await tool(tools, "workspace_grep").execute({
      query: "legacy", pattern: "/workspace/project/*.txt"
    }, signal()))).toEqual([expect.objectContaining({ path: "project/file.txt" })]);
    await expect(tool(tools, "workspace_shell").execute({
      command: "test -f file.txt", cwd: "/workspace/project"
    }, signal())).resolves.toBeTruthy();
    await expect(tool(tools, "workspace_shell").execute({
      command: "test -f file.txt", cwd: "project"
    }, signal())).resolves.toBeTruthy();
    expect(await tool(tools, "workspace_list").execute({ path: "/workspace" }, signal()))
      .toBe(await tool(tools, "workspace_list").execute({ path: "." }, signal()));
    store.close();
  });

  it("edits exact text once or everywhere and rejects ambiguous or absent matches", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    await tool(tools, "workspace_write_file").execute({ path: "repeat.txt", text: "one two one" }, signal());
    const edit = tool(tools, "workspace_edit_file");
    await expect(edit.execute({ path: "repeat.txt", old_text: "one", new_text: "1" }, signal()))
      .rejects.toThrow("occurs 2 times");
    expect(JSON.parse(await edit.execute({
      path: "repeat.txt", old_text: "one", new_text: "1", replace_all: true
    }, signal()))).toMatchObject({ path: "repeat.txt", replacements: 2 });
    await expect(edit.execute({ path: "repeat.txt", old_text: "missing", new_text: "" }, signal()))
      .rejects.toThrow("was not found");
    expect(JSON.parse(await tool(tools, "workspace_read_file").execute({ path: "repeat.txt" }, signal())).text)
      .toBe("1 two 1");
    store.close();
  });

  it("supports confined glob and grep with regex, line truncation, and file-size filtering", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    const workspace = join(store.dataDir, "workspace");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), `Alpha\n${"x".repeat(600)} needle\nbeta`);
    writeFileSync(join(workspace, "src", "big.ts"), Buffer.alloc(1024 * 1024 + 1, 65));
    expect(JSON.parse(await tool(tools, "workspace_glob").execute({ pattern: "**/*.ts" }, signal())))
      .toEqual(expect.arrayContaining(["src/a.ts", "src/big.ts"]));
    const plain = JSON.parse(await tool(tools, "workspace_grep").execute({ query: "NEEDLE", pattern: "**/*.ts" }, signal()));
    expect(plain).toEqual([expect.objectContaining({ path: "src/a.ts", line: 2 })]);
    expect(plain[0].text).toHaveLength(500);
    const regex = JSON.parse(await tool(tools, "workspace_grep").execute({ query: "^(alpha|beta)$", regex: true }, signal()));
    expect(regex.map((item: { line: number }) => item.line)).toEqual([1, 3]);
    await expect(tool(tools, "workspace_glob").execute({ pattern: "../*" }, signal())).rejects.toThrow("relative");
    await expect(tool(tools, "workspace_grep").execute({ query: "[", regex: true }, signal())).rejects.toThrow();
    store.close();
  });

  it("caps directory, glob, and grep result counts", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    const workspace = join(store.dataDir, "workspace");
    const many = join(workspace, "many");
    mkdirSync(many);
    for (let index = 0; index < 1_005; index += 1) writeFileSync(join(many, `${index}.txt`), "match\n");
    const listed = JSON.parse(await tool(tools, "workspace_list").execute({ path: "many" }, signal()));
    const globbed = JSON.parse(await tool(tools, "workspace_glob").execute({ pattern: "many/*.txt" }, signal()));
    expect(listed).toHaveLength(1_000);
    expect(globbed).toHaveLength(1_000);
    writeFileSync(join(workspace, "lines.txt"), Array(210).fill("match").join("\n"));
    const grepped = JSON.parse(await tool(tools, "workspace_grep").execute({ query: "match", pattern: "lines.txt" }, signal()));
    expect(grepped).toHaveLength(200);
    store.close();
  });

  it("rejects escapes, wrong file types, oversized reads, and symlink escapes", async () => {
    const store = createStore();
    const tools = await buildServerTools(store);
    const workspace = join(store.dataDir, "workspace");
    const outside = join(store.dataDir, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(workspace, "link.txt"));
    await expect(tool(tools, "workspace_read_file").execute({ path: "/workspace/../outside.txt" }, signal()))
      .rejects.toThrow(/workspace/);
    await expect(tool(tools, "workspace_read_file").execute({ path: "/workspace" }, signal()))
      .rejects.toThrow("not a file");
    await expect(tool(tools, "workspace_read_file").execute({ path: "link.txt" }, signal()))
      .rejects.toThrow("outside /workspace");
    await expect(tool(tools, "workspace_write_file").execute({ path: "link.txt", text: "overwrite" }, signal()))
      .rejects.toThrow("outside /workspace");
    await expect(tool(tools, "workspace_read_file").execute({ path: "/etc/passwd" }, signal()))
      .rejects.toThrow("inside /workspace");
    await expect(tool(tools, "workspace_read_file").execute({ path: "/workspace-other/file.txt" }, signal()))
      .rejects.toThrow("inside /workspace");
    await expect(tool(tools, "workspace_read_file").execute({ path: "../outside.txt" }, signal()))
      .rejects.toThrow("escapes /workspace");
    const outsideDirectory = join(store.dataDir, "outside-directory");
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, join(workspace, "directory-link"));
    await expect(tool(tools, "workspace_write_file").execute({
      path: "directory-link/new/note.txt", text: "escape"
    }, signal())).rejects.toThrow("outside /workspace");
    expect(existsSync(join(outsideDirectory, "new"))).toBe(false);
    writeFileSync(outside, "secret");
    expect(await tool(tools, "workspace_grep").execute({ query: "secret" }, signal())).toBe("[]");
    writeFileSync(join(workspace, "large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(tool(tools, "workspace_read_file").execute({ path: "large.txt" }, signal()))
      .rejects.toThrow("larger than 8 MiB");
    store.close();
  });
});

describe("JavaScript and shell tools", () => {
  it("returns JavaScript results and logs without exposing Node globals", async () => {
    const store = createStore();
    const javascript = tool(await buildServerTools(store), "eval_javascript");
    expect(JSON.parse(await javascript.execute({ code: "console.log('sum', 3); 1 + 2" }, signal())))
      .toEqual({ result: 3, logs: ["sum 3"] });
    expect(JSON.parse(await javascript.execute({ code: "[typeof process, typeof require, typeof fetch, typeof Buffer]" }, signal())).result)
      .toEqual(["undefined", "undefined", "undefined", "undefined"]);
    await expect(javascript.execute({ code: "throw new Error('boom')" }, signal())).rejects.toThrow("boom");
    store.close();
  });

  it("times out and aborts JavaScript execution", async () => {
    const store = createStore();
    const javascript = tool(await buildServerTools(store), "eval_javascript");
    await expect(javascript.execute({ code: "while (true) {}" }, signal())).rejects.toThrow(/timed out|execution failed/i);
    const controller = new AbortController();
    const pending = javascript.execute({ code: "while (true) {}" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    store.close();
  }, 5_000);

  it("runs enabled shell commands and exposes nonzero, timeout, and abort failures", async () => {
    const store = createStore();
    store.updateToolSettings({ workspaceShellEnabled: true });
    const shell = tool(await buildServerTools(store), "workspace_shell");
    expect(shell.available).toBe(true);
    expect(JSON.parse(await shell.execute({ command: "pwd; printf ok; printf warn >&2" }, signal())))
      .toMatchObject({ exitCode: 0, stdout: expect.stringContaining("ok"), stderr: "warn" });
    await expect(shell.execute({ command: "printf bad >&2; exit 7" }, signal())).rejects.toMatchObject({ code: 7 });
    await expect(shell.execute({ command: "sleep 2", timeout: 1 }, signal())).rejects.toThrow();
    const controller = new AbortController();
    const pending = shell.execute({ command: "sleep 5" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    store.close();
  }, 5_000);
});

describe("fetch and search tools", () => {
  it.each([
    "file:///etc/passwd", "http://user:pass@93.184.216.34/", "http://127.0.0.1/",
    "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.1.1/",
    "http://224.0.0.1/", "http://[::1]/", "http://[fe80::1]/", "http://[fc00::1]/"
  ])("blocks unsafe URL %s before fetching", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore();
    const fetchTool = tool(await buildServerTools(store), "fetch_url");
    await expect(fetchTool.execute({ url }, signal())).rejects.toThrow(/allowed|credentials|blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
    store.close();
  });

  it("validates every DNS answer and every redirect target", async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === "public.test"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "192.168.1.2", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://private.test/secret" } }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createStore();
    const fetchTool = tool(await buildServerTools(store, false, { lookup: lookup as never }), "fetch_url");
    await expect(fetchTool.execute({ url: "https://public.test/start" }, signal())).rejects.toThrow("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("private.test", { all: true });
    store.close();
  });

  it("handles status, redirects, content limits, HTML conversion, and abort", async () => {
    const store = createStore();
    const fetchTool = tool(await buildServerTools(store), "fetch_url");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<h1>Hello &amp; world</h1><script>secret()</script>", {
      headers: { "content-type": "text/html" }
    })));
    expect(JSON.parse(await fetchTool.execute({ url: "https://93.184.216.34/page" }, signal())).text).toBe("Hello & world");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 503 })));
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).rejects.toThrow("HTTP 503");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })));
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).rejects.toThrow("larger than 2 MiB");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))));
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).rejects.toThrow("larger than 2 MiB");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(40_000), { headers: { "content-type": "text/plain" } })));
    expect(JSON.parse(await fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).text).toHaveLength(32 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).rejects.toThrow("Location");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } })));
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, signal())).rejects.toThrow("Too many redirects");
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("late");
    }));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchTool.execute({ url: "https://93.184.216.34/" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    store.close();
  });

  it("builds SearXNG requests with auth and maps limited results and errors", async () => {
    const store = createStore();
    store.updateToolSettings({ search: { baseUrl: "https://search.test", apiKey: "token" } });
    const search = tool(await buildServerTools(store), "search_web");
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => Response.json({ results: [
      { title: "One", url: "https://one.test", content: "first" },
      { title: "Two" }, { title: "Three" }
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = JSON.parse(await search.execute({ query: "a & b", limit: 2 }, signal()));
    expect(result).toEqual([
      { id: 1, title: "One", url: "https://one.test", text: "first" },
      { id: 2, title: "Two", url: "", text: "" }
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/search?q=a+%26+b&format=json");
    expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 429 })));
    await expect(search.execute({ query: "x" }, signal())).rejects.toThrow("HTTP 429");
    store.updateToolSettings({ search: { baseUrl: "", apiKey: "" } });
    await expect(search.execute({ query: "x" }, signal())).rejects.toThrow("not configured");
    store.close();
  });
});

describe("memory, chat, skill, and large-output tools", () => {
  it("creates, edits, deletes, and reports missing memories", async () => {
    const store = createStore();
    const memory = tool(await buildServerTools(store), "memory_tool");
    const created = JSON.parse(await memory.execute({ action: "create", content: "Use <Chinese> & concise." }, signal()));
    expect(toolSystemPrompt(store)).toContain("Use &lt;Chinese&gt; &amp; concise.");
    expect(JSON.parse(await memory.execute({ action: "edit", id: created.id, content: "Updated" }, signal())).content).toBe("Updated");
    expect(JSON.parse(await memory.execute({ action: "delete", id: created.id }, signal()))).toEqual({ success: true, id: created.id });
    await expect(memory.execute({ action: "edit", id: created.id, content: "gone" }, signal())).rejects.toThrow("不存在");
    await expect(memory.execute({ action: "delete", id: created.id }, signal())).rejects.toThrow("不存在");
    store.close();
  });

  it("lists recent chats and searches user and assistant content", async () => {
    const store = createStore();
    seedModel(store);
    const conversation = store.createConversation({ title: "Project", systemPrompt: "" });
    const generation = store.createMessageGeneration(conversation.id, "find user needle");
    store.updateGenerationBlock(generation.generationId, 1, "text", "assistant needle", true);
    const tools = await buildServerTools(store);
    expect(JSON.parse(await tool(tools, "recent_chats").execute({ limit: 10 }, signal())))
      .toEqual([expect.objectContaining({ id: conversation.id, title: "Project" })]);
    const matches = JSON.parse(await tool(tools, "conversation_search").execute({ query: "needle", limit: 10 }, signal()));
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ conversationId: conversation.id, title: "Project" });
    store.close();
  });

  it("loads valid skills and confines linked paths and symlinks", async () => {
    const store = createStore();
    const skillDir = join(store.dataDir, "skills", "writer");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: writer\ndescription: Write clearly\n---\nUse short sentences.\n");
    writeFileSync(join(skillDir, "guide.md"), "Guide");
    mkdirSync(join(store.dataDir, "skills", "invalid"));
    const outside = join(store.dataDir, "outside.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(skillDir, "outside.md"));
    const skillTool = tool(await buildServerTools(store), "use_skill");
    expect(skillTool.available).toBe(true);
    await expect(skillTool.execute({ name: "writer" }, signal())).resolves.toContain("Use short sentences");
    await expect(skillTool.execute({ name: "writer", path: "guide.md" }, signal())).resolves.toBe("Guide");
    await expect(skillTool.execute({ name: "missing" }, signal())).rejects.toThrow("not available");
    await expect(skillTool.execute({ name: "writer", path: "../SKILL.md" }, signal())).rejects.toThrow("escapes");
    await expect(skillTool.execute({ name: "writer", path: "outside.md" }, signal())).rejects.toThrow("outside");
    store.close();
  });

  it("persists large output under a sanitized private filename and returns a preview", async () => {
    const store = createStore();
    expect(await persistLargeToolOutput(store, "small", "ok")).toBe("ok");
    const output = "x".repeat(40_000);
    const preview = await persistLargeToolOutput(store, "../unsafe call", output);
    const path = join(store.dataDir, "tool_outputs", ".._unsafe_call.txt");
    expect(preview).toContain("Output truncated: 40000 characters");
    expect(preview).toContain(path);
    expect(statSync(path).size).toBe(40_000);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(store.dataDir, "tool_outputs")).mode & 0o777).toBe(0o700);
    chmodSync(path, 0o600);
    store.close();
  });
});
