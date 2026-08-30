import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api, generationEvents } from "./api";

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED; });

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  emit(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }));
  }
}

const jsonResponse = (body: unknown = { ok: true }, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" }, ...init
});

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse())));
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("constructs every endpoint with its expected method and JSON body", async () => {
    const cases: Array<[() => Promise<unknown>, string, string, unknown?]> = [
      [api.settings, "/api/settings", "GET"],
      [() => api.updateSettings({ theme: "dark" }), "/api/settings", "PATCH", { theme: "dark" }],
      [api.connections, "/api/connections", "GET"],
      [() => api.createConnection({ name: "x", protocol: "openai-chat", baseUrl: "https://x", secretHeaders: {} }), "/api/connections", "POST", { name: "x", protocol: "openai-chat", baseUrl: "https://x", secretHeaders: {} }],
      [() => api.updateConnection("c 1", { name: "new" }), "/api/connections/c 1", "PATCH", { name: "new" }],
      [() => api.deleteConnection("c1"), "/api/connections/c1", "DELETE"],
      [() => api.testConnection("c1"), "/api/connections/c1/test", "POST"],
      [() => api.discoverModels("c1"), "/api/connections/c1/models/discover", "POST"],
      [api.models, "/api/models", "GET"],
      [() => api.createModel({} as never), "/api/models", "POST", {}],
      [() => api.updateModel("m1", { enabled: false }), "/api/models/m1", "PATCH", { enabled: false }],
      [() => api.deleteModel("m1"), "/api/models/m1", "DELETE"],
      [api.agents, "/api/agents", "GET"],
      [() => api.agent("a1"), "/api/agents/a1", "GET"],
      [() => api.createAgent({} as never), "/api/agents", "POST", {}],
      [() => api.updateAgent("a1", { userProfile: { displayName: "Lin" } }), "/api/agents/a1", "PATCH", { userProfile: { displayName: "Lin" } }],
      [() => api.deleteAgent("a1"), "/api/agents/a1", "DELETE"],
      [() => api.importAgent("card.json", "e30="), "/api/agents/import", "POST", { fileName: "card.json", dataBase64: "e30=" }],
      [() => api.updateAgentAvatar("a1", "avatar.png", "eA=="), "/api/agents/a1/avatar", "PUT", { fileName: "avatar.png", dataBase64: "eA==" }],
      [() => api.deleteAgentAvatar("a1"), "/api/agents/a1/avatar", "DELETE"],
      [api.conversations, "/api/conversations", "GET"],
      [() => api.createConversation({ agentId: "a1" }), "/api/conversations", "POST", { agentId: "a1" }],
      [() => api.startConversation({ text: "hi", agentId: "a1", greetingIndex: 1, executionOverrides: { contextPolicy: "trim" } }), "/api/conversations/start", "POST", { text: "hi", agentId: "a1", greetingIndex: 1, executionOverrides: { contextPolicy: "trim" } }],
      [() => api.updateConversation("c1", { draft: "d" }), "/api/conversations/c1", "PATCH", { draft: "d" }],
      [() => api.deleteConversation("c1"), "/api/conversations/c1", "DELETE"],
      [() => api.messages("c1"), "/api/conversations/c1/messages", "GET"],
      [() => api.send("c1", { text: "hi" }), "/api/conversations/c1/messages", "POST", { text: "hi" }],
      [() => api.retry("msg"), "/api/messages/msg/generations", "POST", {}],
      [() => api.selectGeneration("msg", "gen"), "/api/messages/msg/active-generation", "PATCH", { generationId: "gen" }],
      [() => api.cancel("gen"), "/api/generations/gen/cancel", "POST"],
      [() => api.generation("gen"), "/api/generations/gen", "GET"],
      [api.toolSettings, "/api/tools/settings", "GET"],
      [() => api.updateToolSettings({ enabled: { search: true } }), "/api/tools/settings", "PATCH", { enabled: { search: true } }],
      [api.toolCatalog, "/api/tools/catalog", "GET"],
      [() => api.approveTool("call/a b", true, "because"), "/api/tool-calls/call%2Fa%20b/approval", "POST", { approved: true, reason: "because" }],
      [() => api.approveTool("call", false), "/api/tool-calls/call/approval", "POST", { approved: false }],
      [api.mcpServers, "/api/mcp/servers", "GET"],
      [() => api.createMcpServer({ name: "mcp", url: "https://x", headers: {}, enabled: true }), "/api/mcp/servers", "POST", { name: "mcp", url: "https://x", headers: {}, enabled: true }],
      [() => api.updateMcpServer("s1", { enabled: false }), "/api/mcp/servers/s1", "PATCH", { enabled: false }],
      [() => api.deleteMcpServer("s1"), "/api/mcp/servers/s1", "DELETE"],
      [() => api.testMcpServer("s1"), "/api/mcp/servers/s1/test", "POST"]
    ];

    for (const [call, path, method, body] of cases) {
      vi.mocked(fetch).mockClear();
      await call();
      const [actualPath, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(actualPath).toBe(path);
      expect(init?.method ?? "GET").toBe(method);
      const headers = new Headers(init?.headers);
      if (body === undefined) {
        expect(init?.body).toBeUndefined();
        expect(headers.has("content-type")).toBe(false);
      } else {
        expect(headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual(body);
      }
    }
  });

  it("preserves caller headers while assigning JSON content type", async () => {
    await api.updateSettings({ theme: "light" });
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("returns undefined for a successful 204", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteConnection("c1")).resolves.toBeUndefined();
  });

  it("normalizes structured, partial, and non-JSON failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: { code: "invalid", message: "Nope" } }, { status: 422 }));
    await expect(api.settings()).rejects.toEqual(new ApiClientError("invalid", "Nope"));

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: {} }, { status: 500 }));
    await expect(api.settings()).rejects.toMatchObject({ code: "request_failed", message: "请求失败（500）" });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("not json", { status: 503 }));
    await expect(api.settings()).rejects.toMatchObject({ code: "request_failed", message: "请求失败（503）" });
  });

  it("registers and parses all generation event types and ignores malformed payloads", () => {
    const onEvent = vi.fn();
    const unsubscribe = generationEvents("gen id", onEvent);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/generations/gen id/events");
    expect([...source.listeners.keys()]).toEqual(["snapshot", "block-delta", "tool-call", "usage", "status", "error"]);
    for (const type of source.listeners.keys()) source.emit(type, JSON.stringify({ type, marker: type }));
    source.emit("status", "{");
    expect(onEvent).toHaveBeenCalledTimes(6);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "error", marker: "error" });
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("closes only when EventSource reports a terminal error", () => {
    generationEvents("g", vi.fn());
    const source = FakeEventSource.instances[0]!;
    source.onerror?.(new Event("error"));
    expect(source.close).not.toHaveBeenCalled();
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.(new Event("error"));
    expect(source.close).toHaveBeenCalledOnce();
  });
});
