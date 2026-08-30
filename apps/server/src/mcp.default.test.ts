import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

interface MockClient {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  getServerVersion: ReturnType<typeof vi.fn>;
}

const sdk = vi.hoisted(() => {
  const clients: MockClient[] = [];
  const connectErrors: Array<Error | undefined> = [];
  const httpTransports: Array<{ kind: "http" }> = [];
  const sseTransports: Array<{ kind: "sse" }> = [];

  const Client = vi.fn(function MockSdkClient(_metadata: unknown) {
    const connectError = connectErrors.shift();
    const client: MockClient = {
      connect: vi.fn(async () => {
        if (connectError) throw connectError;
      }),
      close: vi.fn(async () => {}),
      listTools: vi.fn(async () => ({
        tools: [{ name: "status", description: "Current status", inputSchema: { type: "object" } }]
      })),
      callTool: vi.fn(async () => ({ content: [] })),
      getServerVersion: vi.fn(() => ({ name: "Mock MCP", version: "1.0.0" }))
    };
    clients.push(client);
    return client;
  });

  const StreamableHTTPClientTransport = vi.fn(function MockHttpTransport(
    _url: URL,
    _options: { requestInit: RequestInit }
  ) {
    const transport = { kind: "http" as const };
    httpTransports.push(transport);
    return transport;
  });

  const SSEClientTransport = vi.fn(function MockSseTransport(
    _url: URL,
    _options: { requestInit: RequestInit }
  ) {
    const transport = { kind: "sse" as const };
    sseTransports.push(transport);
    return transport;
  });

  return {
    Client,
    StreamableHTTPClientTransport,
    SSEClientTransport,
    clients,
    connectErrors,
    httpTransports,
    sseTransports
  };
});

vi.mock("@modelcontextprotocol/client", () => ({
  Client: sdk.Client,
  StreamableHTTPClientTransport: sdk.StreamableHTTPClientTransport,
  SSEClientTransport: sdk.SSEClientTransport
}));

import { McpManager } from "./mcp";
import { cleanupStores, createStore } from "./test-helpers";

const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  cleanupStores();
  sdk.clients.length = 0;
  sdk.connectErrors.length = 0;
  sdk.httpTransports.length = 0;
  sdk.sseTransports.length = 0;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("@modelcontextprotocol/client");
});

describe("MCP production dependency defaults", () => {
  it("creates the SDK client and Streamable HTTP transport with the server request settings", async () => {
    const store = createStore();
    const headers = { Authorization: "Bearer test-token", "X-Tenant": "test" };
    const server = store.createMcpServer({
      name: "Default HTTP",
      url: "https://mcp.example/http",
      headers,
      enabled: true
    });
    const manager = new McpManager(store);
    managers.push(manager);

    await expect(manager.tools()).resolves.toHaveLength(1);

    expect(sdk.Client).toHaveBeenCalledWith({ name: "llm-chat", version: "0.1.0" });
    expect(sdk.StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL(server.url), {
      requestInit: { headers }
    });
    expect(sdk.SSEClientTransport).not.toHaveBeenCalled();
    expect(sdk.clients[0]?.connect).toHaveBeenCalledWith(sdk.httpTransports[0]);
    expect(sdk.clients[0]?.listTools).toHaveBeenCalledWith(undefined, { timeout: 15_000 });

    await manager.close();
    expect(sdk.clients[0]?.close).toHaveBeenCalledOnce();
  });

  it("creates a fresh SDK client and the SSE transport after the HTTP connection fails", async () => {
    sdk.connectErrors.push(new Error("HTTP connect failed"), undefined);
    const store = createStore();
    const headers = { "X-API-Key": "test-key" };
    const server = store.createMcpServer({
      name: "Default fallback",
      url: "https://mcp.example/fallback",
      headers,
      enabled: true
    });
    const manager = new McpManager(store);
    managers.push(manager);

    await expect(manager.tools()).resolves.toHaveLength(1);

    expect(sdk.Client).toHaveBeenCalledTimes(2);
    expect(sdk.clients[0]).not.toBe(sdk.clients[1]);
    expect(sdk.StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL(server.url), {
      requestInit: { headers }
    });
    expect(sdk.SSEClientTransport).toHaveBeenCalledWith(new URL(server.url), {
      requestInit: { headers }
    });
    expect(sdk.clients[0]?.connect).toHaveBeenCalledWith(sdk.httpTransports[0]);
    expect(sdk.clients[0]?.close).toHaveBeenCalledOnce();
    expect(sdk.clients[1]?.connect).toHaveBeenCalledWith(sdk.sseTransports[0]);
    expect(sdk.clients[1]?.listTools).toHaveBeenCalledWith(undefined, { timeout: 15_000 });

    await manager.close();
    expect(sdk.clients[1]?.close).toHaveBeenCalledOnce();
  });
});
