import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { Store } from "./database";
import type { ServerTool } from "./tools";

interface Session {
  client: McpClient;
  transport: Transport;
  fingerprint: string;
}

type McpClient = Pick<Client, "connect" | "close" | "listTools" | "callTool" | "getServerVersion">;

export interface McpManagerDependencies {
  createClient: () => McpClient;
  createHttpTransport: (url: URL, requestInit: RequestInit) => Transport;
  createSseTransport: (url: URL, requestInit: RequestInit) => Transport;
}

const defaultDependencies: McpManagerDependencies = {
  createClient: () => new Client({ name: "llm-chat", version: "0.1.0" }),
  createHttpTransport: (url, requestInit) => new StreamableHTTPClientTransport(url, { requestInit }),
  createSseTransport: (url, requestInit) => new SSEClientTransport(url, { requestInit })
};

const managers = new WeakMap<Store, McpManager>();

export function mcpManager(store: Store): McpManager {
  let manager = managers.get(store);
  if (!manager) {
    manager = new McpManager(store);
    managers.set(store, manager);
  }
  return manager;
}

export async function closeMcpManager(store: Store): Promise<void> {
  await managers.get(store)?.close();
  managers.delete(store);
}

export class McpManager {
  private readonly sessions = new Map<string, Session>();
  private readonly dependencies: McpManagerDependencies;

  constructor(private readonly store: Store, dependencies: Partial<McpManagerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async tools(): Promise<ServerTool[]> {
    const result: ServerTool[] = [];
    for (const server of this.store.listMcpServers().filter((item) => item.enabled)) {
      try {
        const session = await this.session(server.id);
        const listed = await session.client.listTools(undefined, { timeout: 15_000 });
        this.store.setMcpServerError(server.id, null);
        for (const remote of listed.tools) {
          const name = `mcp__${server.name}__${normalizeName(remote.name)}`;
          result.push({
            definition: {
              name,
              description: remote.description ?? remote.title ?? `MCP tool ${remote.name} from ${server.name}`,
              inputSchema: remote.inputSchema as Record<string, unknown>
            },
            label: `${server.name} / ${remote.title ?? remote.name}`,
            category: "mcp",
            available: true,
            requiresApproval: () => remote.annotations?.readOnlyHint !== true || remote.annotations?.destructiveHint === true,
            execute: async (input, signal) => {
              const live = await this.session(server.id);
              const output = await live.client.callTool(
                { name: remote.name, arguments: input },
                { timeout: 120_000, signal, toolDefinition: remote }
              );
              if (output.isError) throw new Error(toolResultText(output));
              return toolResultText(output);
            }
          });
        }
      } catch (error) {
        this.store.setMcpServerError(server.id, error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  async test(serverId: string): Promise<{ ok: true; tools: number; serverName: string }> {
    this.invalidate(serverId);
    const session = await this.session(serverId);
    const result = await session.client.listTools(undefined, { timeout: 15_000, cacheMode: "refresh" });
    this.store.setMcpServerError(serverId, null);
    return { ok: true, tools: result.tools.length, serverName: session.client.getServerVersion()?.name ?? "MCP" };
  }

  invalidate(serverId: string): void {
    const existing = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    if (existing) void existing.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.client.close()));
  }

  private async session(serverId: string): Promise<Session> {
    const server = this.store.getMcpServer(serverId);
    if (!server || !server.enabled) throw new Error("MCP server is unavailable");
    const fingerprint = JSON.stringify([server.url, server.headers]);
    const existing = this.sessions.get(serverId);
    if (existing?.fingerprint === fingerprint) return existing;
    this.invalidate(serverId);

    const requestInit: RequestInit = { headers: server.headers };
    let client = this.dependencies.createClient();
    let transport = this.dependencies.createHttpTransport(new URL(server.url), requestInit);
    try {
      await client.connect(transport);
    } catch (firstError) {
      await client.close().catch(() => {});
      client = this.dependencies.createClient();
      transport = this.dependencies.createSseTransport(new URL(server.url), requestInit);
      try {
        await client.connect(transport);
      } catch {
        await client.close().catch(() => {});
        throw firstError;
      }
    }
    const session = { client, transport, fingerprint };
    this.sessions.set(serverId, session);
    return session;
  }
}

function normalizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "tool";
}

function toolResultText(output: { content: unknown[]; structuredContent?: unknown }): string {
  const blocks = output.content.map((item) => {
    if (item && typeof item === "object" && "type" in item && (item as { type: unknown }).type === "text") {
      return String((item as { text?: unknown }).text ?? "");
    }
    return JSON.stringify(item);
  }).filter(Boolean);
  if (output.structuredContent !== undefined) blocks.push(JSON.stringify(output.structuredContent));
  return blocks.join("\n") || "{}";
}
