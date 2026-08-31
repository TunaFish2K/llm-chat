export type JsonObject = Record<string, unknown>;

export type ToolSpec = {
  name: string;
  label?: string;
  description: string;
  category?: string;
  inputSchema: Record<string, unknown>;
  requiresApproval?: boolean | ((input: JsonObject) => boolean | Promise<boolean>);
  execute: (input: JsonObject, context: JsonObject) => unknown | Promise<unknown>;
};

export interface PluginApi {
  config: Readonly<JsonObject>;
  registerTool(spec: ToolSpec): void;
}

export type PluginTools = Map<string, ToolSpec>;

type HostRequest = {
  id?: string;
  type?: string;
  tool?: string;
  input?: JsonObject;
  context?: JsonObject;
};

export function createPluginRegistry(config: JsonObject, secrets: JsonObject): {
  api: Readonly<PluginApi>;
  tools: PluginTools;
} {
  const tools: PluginTools = new Map();
  const api: PluginApi = Object.freeze({
    config: Object.freeze({ ...config, ...secrets }),
    registerTool(spec: ToolSpec) {
      if (!spec || typeof spec !== "object" || !/^[A-Za-z0-9_-]+$/.test(spec.name) || typeof spec.execute !== "function") {
        throw new Error("Invalid tool registration");
      }
      if (tools.has(spec.name)) throw new Error(`Duplicate tool name: ${spec.name}`);
      tools.set(spec.name, spec);
    }
  });
  return { api, tools };
}

export function describePluginTools(tools: PluginTools): Array<Record<string, unknown>> {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    category: tool.category ?? "plugin",
    inputSchema: tool.inputSchema,
    approvalMode: typeof tool.requiresApproval === "function" ? "dynamic" : tool.requiresApproval ? "always" : "never"
  }));
}

export async function handlePluginLine(tools: PluginTools, line: string): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const message = parsed as HostRequest;
  if (!message.id) return undefined;
  try {
    if (message.type === "ping") return { id: message.id, ok: true, result: "pong" };
    const tool = message.tool ? tools.get(message.tool) : undefined;
    if (!tool) throw new Error("Plugin tool not found");
    if (message.type === "approval") {
      const result = typeof tool.requiresApproval === "function"
        ? await tool.requiresApproval(message.input ?? {})
        : Boolean(tool.requiresApproval);
      return { id: message.id, ok: true, result: Boolean(result) };
    }
    if (message.type === "execute") {
      const result = await tool.execute(message.input ?? {}, message.context ?? {});
      return { id: message.id, ok: true, result: typeof result === "string" ? result : JSON.stringify(result ?? {}) };
    }
    throw new Error("Unknown plugin host request");
  } catch (error) {
    return { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function serializeHostMessage(value: unknown): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Plugin host response is too large");
  return `${line}\n`;
}
