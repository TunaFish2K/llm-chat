import type { Transport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "./database";
import {
  closeMcpManager,
  McpManager,
  mcpManager,
  type McpManagerDependencies
} from "./mcp";
import { cleanupStores, createStore } from "./test-helpers";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupStores();
});

describe("MCP manager sessions", () => {
  it("keeps one manager per store and removes it on close", async () => {
    const store = createStore();
    const first = mcpManager(store);
    expect(mcpManager(store)).toBe(first);

    await closeMcpManager(store);
    expect(mcpManager(store)).not.toBe(first);
    await closeMcpManager(store);
  });

  it("filters disabled servers, connects over Streamable HTTP, and reuses the session", async () => {
    const store = createStore();
    createServer(store, "Disabled", false);
    const enabled = createServer(store, "Enabled", true, { Authorization: "Bearer secret" });
    const client = fakeClient({ tools: [remoteTool("ping")] });
    const harness = managerHarness(store, [client]);

    expect((await harness.manager.tools()).map((tool) => tool.definition.name)).toEqual(["mcp__Enabled__ping"]);
    expect(await harness.manager.tools()).toHaveLength(1);
    expect(harness.createClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(harness.http).toHaveBeenCalledWith(new URL(enabled.url), { headers: { Authorization: "Bearer secret" } });
    expect(harness.sse).not.toHaveBeenCalled();
    expect(store.getMcpServer(enabled.id)?.lastError).toBeNull();
    await harness.manager.close();
  });

  it("falls back from Streamable HTTP to SSE", async () => {
    const store = createStore();
    createServer(store, "Fallback");
    const first = fakeClient({ connectError: new Error("http unavailable") });
    const second = fakeClient({ tools: [remoteTool("ok")] });
    const harness = managerHarness(store, [first, second]);

    expect(await harness.manager.tools()).toHaveLength(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(harness.http).toHaveBeenCalledOnce();
    expect(harness.sse).toHaveBeenCalledOnce();
    expect(second.connect).toHaveBeenCalledWith(harness.sse.mock.results[0]?.value);
    await harness.manager.close();
  });

  it("isolates both transport failures and records the first error", async () => {
    const store = createStore();
    const server = createServer(store, "Broken");
    const first = fakeClient({ connectError: new Error("HTTP failed") });
    const second = fakeClient({ connectError: new Error("SSE failed") });
    const harness = managerHarness(store, [first, second]);

    expect(await harness.manager.tools()).toEqual([]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(store.getMcpServer(server.id)?.lastError).toBe("HTTP failed");
  });

  it("invalidates a session when its URL or headers fingerprint changes", async () => {
    const store = createStore();
    const server = createServer(store, "Mutable");
    const first = fakeClient({ tools: [remoteTool("one")] });
    const second = fakeClient({ tools: [remoteTool("two")] });
    const harness = managerHarness(store, [first, second]);

    await harness.manager.tools();
    store.updateMcpServer(server.id, { url: "https://changed.example/mcp", headers: { "X-New": "yes" } });
    expect((await harness.manager.tools())[0]?.definition.name).toBe("mcp__Mutable__two");
    expect(first.close).toHaveBeenCalledOnce();
    expect(harness.createClient).toHaveBeenCalledTimes(2);
    expect(harness.http).toHaveBeenLastCalledWith(new URL("https://changed.example/mcp"), { headers: { "X-New": "yes" } });
    await harness.manager.close();
  });

  it("supports explicit invalidation and closes every live session", async () => {
    const store = createStore();
    const one = createServer(store, "One");
    createServer(store, "Two");
    const clients = [fakeClient(), fakeClient(), fakeClient()];
    const harness = managerHarness(store, clients);
    await harness.manager.tools();

    harness.manager.invalidate(one.id);
    expect(clients[0]?.close).toHaveBeenCalledOnce();
    await harness.manager.tools();
    expect(harness.createClient).toHaveBeenCalledTimes(3);
    await harness.manager.close();
    expect(clients[1]?.close).toHaveBeenCalledOnce();
    expect(clients[2]?.close).toHaveBeenCalledOnce();
    await harness.manager.close();
  });

  it("refreshes a server for test and reports its version and tool count", async () => {
    const store = createStore();
    const server = createServer(store, "Tester");
    const stale = fakeClient();
    const fresh = fakeClient({ tools: [remoteTool("a"), remoteTool("b")], version: "Fresh MCP" });
    const harness = managerHarness(store, [stale, fresh]);
    await harness.manager.tools();

    await expect(harness.manager.test(server.id)).resolves.toEqual({ ok: true, tools: 2, serverName: "Fresh MCP" });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.listTools).toHaveBeenCalledWith(undefined, { timeout: 15_000, cacheMode: "refresh" });
    expect(store.getMcpServer(server.id)?.lastError).toBeNull();
    await harness.manager.close();
  });

  it("isolates list failures per server and updates lastError independently", async () => {
    const store = createStore();
    const broken = createServer(store, "AFirst");
    const healthy = createServer(store, "BSecond");
    store.setMcpServerError(healthy.id, "old error");
    const failedClient = fakeClient({ listError: new Error("list failed") });
    const healthyClient = fakeClient({ tools: [remoteTool("works")] });
    const harness = managerHarness(store, [failedClient, healthyClient]);

    expect((await harness.manager.tools()).map((tool) => tool.definition.name)).toEqual(["mcp__BSecond__works"]);
    expect(store.getMcpServer(broken.id)?.lastError).toBe("list failed");
    expect(store.getMcpServer(healthy.id)?.lastError).toBeNull();
    await harness.manager.close();
  });
});

describe("MCP tool mapping", () => {
  it("normalizes names and maps labels, descriptions, schemas, and approval hints", async () => {
    const store = createStore();
    createServer(store, "Tools");
    const longName = `bad name/${"x".repeat(60)}`;
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const remotes = [
      remoteTool(longName, { title: "Search Title", description: "Search description", inputSchema: schema, annotations: { readOnlyHint: true } }),
      remoteTool("destructive", { annotations: { readOnlyHint: true, destructiveHint: true } }),
      remoteTool("write", { title: "Writer" }),
      remoteTool("fallback", { description: undefined, title: undefined })
    ];
    const harness = managerHarness(store, [fakeClient({ tools: remotes })]);
    const tools = await harness.manager.tools();

    expect(tools[0]).toMatchObject({
      definition: {
        name: `mcp__Tools__${longName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`,
        description: "Search description",
        inputSchema: schema
      },
      label: "Tools / Search Title",
      category: "mcp",
      available: true
    });
    expect(tools[0]?.requiresApproval({})).toBe(false);
    expect(tools[1]?.requiresApproval({})).toBe(true);
    expect(tools[2]?.requiresApproval({})).toBe(true);
    expect(tools[2]?.label).toBe("Tools / Writer");
    expect(tools[3]?.definition.description).toBe("MCP tool fallback from Tools");
    await harness.manager.close();
  });

  it("forwards call arguments, options, signal, and the remote definition", async () => {
    const store = createStore();
    createServer(store, "Calls");
    const remote = remoteTool("lookup");
    const client = fakeClient({ tools: [remote], callResult: { content: [{ type: "text", text: "answer" }] } });
    const harness = managerHarness(store, [client]);
    const [tool] = await harness.manager.tools();
    const controller = new AbortController();

    await expect(tool!.execute({ q: "value" }, controller.signal)).resolves.toBe("answer");
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { q: "value" } },
      { timeout: 120_000, signal: controller.signal, toolDefinition: remote }
    );
    expect(harness.createClient).toHaveBeenCalledOnce();
    await harness.manager.close();
  });

  it.each([
    ["text", { content: [{ type: "text", text: "hello" }] }, "hello"],
    ["non-text", { content: [{ type: "image", data: "abc", mimeType: "image/png" }] }, "{\"type\":\"image\",\"data\":\"abc\",\"mimeType\":\"image/png\"}"],
    ["structured", { content: [{ type: "text", text: "summary" }], structuredContent: { count: 2 } }, "summary\n{\"count\":2}"],
    ["empty", { content: [] }, "{}"]
  ])("converts %s results to stable text", async (_case, callResult, expected) => {
    const store = createStore();
    createServer(store, "Result");
    const harness = managerHarness(store, [fakeClient({ tools: [remoteTool("result")], callResult })]);
    const [tool] = await harness.manager.tools();

    await expect(tool!.execute({}, new AbortController().signal)).resolves.toBe(expected);
    await harness.manager.close();
  });

  it("throws the converted result when MCP marks a call as an error", async () => {
    const store = createStore();
    createServer(store, "Errors");
    const harness = managerHarness(store, [fakeClient({
      tools: [remoteTool("explode")],
      callResult: { isError: true, content: [{ type: "text", text: "remote exploded" }] }
    })]);
    const [tool] = await harness.manager.tools();

    await expect(tool!.execute({}, new AbortController().signal)).rejects.toThrow("remote exploded");
    await harness.manager.close();
  });
});

function createServer(store: Store, name: string, enabled = true, headers: Record<string, string> = {}) {
  return store.createMcpServer({ name, url: `https://${name.toLowerCase()}.example/mcp`, headers, enabled });
}

function remoteTool(name: string, patch: Record<string, unknown> = {}) {
  return {
    name,
    inputSchema: { type: "object" },
    ...patch
  };
}

function fakeClient(options: {
  tools?: ReturnType<typeof remoteTool>[];
  connectError?: Error;
  listError?: Error;
  callResult?: Record<string, unknown>;
  version?: string;
} = {}) {
  return {
    connect: vi.fn(async () => {
      if (options.connectError) throw options.connectError;
    }),
    close: vi.fn(async () => {}),
    listTools: vi.fn(async () => {
      if (options.listError) throw options.listError;
      return { tools: options.tools ?? [] };
    }),
    callTool: vi.fn(async () => options.callResult ?? { content: [] }),
    getServerVersion: vi.fn(() => options.version ? { name: options.version, version: "1.0" } : undefined)
  };
}

function managerHarness(store: Store, clients: ReturnType<typeof fakeClient>[]) {
  const queue = [...clients];
  const createClient = vi.fn(() => {
    const client = queue.shift();
    if (!client) throw new Error("No fake MCP client remains");
    return client as unknown as ReturnType<McpManagerDependencies["createClient"]>;
  });
  const http = vi.fn(() => ({ kind: "http" }) as unknown as Transport);
  const sse = vi.fn(() => ({ kind: "sse" }) as unknown as Transport);
  return {
    manager: new McpManager(store, { createClient, createHttpTransport: http, createSseTransport: sse }),
    createClient,
    http,
    sse
  };
}
