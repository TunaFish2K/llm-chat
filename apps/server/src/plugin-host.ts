import { createInterface } from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type ToolSpec = {
  name: string;
  label?: string;
  description: string;
  category?: string;
  inputSchema: Record<string, unknown>;
  requiresApproval?: boolean | ((input: JsonObject) => boolean | Promise<boolean>);
  execute: (input: JsonObject, context: JsonObject) => unknown | Promise<unknown>;
};

const entry = process.argv[2];
if (!entry) throw new Error("Plugin entry is required");
const input = createInterface({ input: process.stdin });
const [initialLine] = await once(input, "line") as [string];
if (Buffer.byteLength(initialLine) > 8 * 1024 * 1024) throw new Error("Plugin initialization is too large");
const initialization = JSON.parse(initialLine) as { type?: string; config?: JsonObject; secrets?: JsonObject };
if (initialization.type !== "initialize") throw new Error("Plugin initialization is required");
const config = initialization.config ?? {};
const secrets = initialization.secrets ?? {};

const tools = new Map<string, ToolSpec>();
interface PluginApi {
  config: Readonly<JsonObject>;
  registerTool(spec: ToolSpec): void;
}
const api = Object.freeze({
  config: Object.freeze({ ...config, ...secrets }),
  registerTool(spec: ToolSpec) {
    if (!spec || typeof spec !== "object" || !/^[A-Za-z0-9_-]+$/.test(spec.name) || typeof spec.execute !== "function") {
      throw new Error("Invalid tool registration");
    }
    if (tools.has(spec.name)) throw new Error(`Duplicate tool name: ${spec.name}`);
    tools.set(spec.name, spec);
  }
});

const imported = await import(`${pathToFileURL(entry).href}?host=${Date.now()}`) as {
  default?: (api: PluginApi) => unknown;
  register?: (api: PluginApi) => unknown;
};
const register = imported.register ?? imported.default;
if (typeof register !== "function") throw new Error("Plugin must export register(api) or a default registration function");
await register(api);
send({ type: "ready", tools: [...tools.values()].map((tool) => ({
  name: tool.name,
  label: tool.label ?? tool.name,
  description: tool.description,
  category: tool.category ?? "plugin",
  inputSchema: tool.inputSchema,
  approvalMode: typeof tool.requiresApproval === "function" ? "dynamic" : tool.requiresApproval ? "always" : "never"
})) });

input.on("line", (line) => {
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) return process.exit(70);
  void handle(line);
});

async function handle(line: string): Promise<void> {
  let message: { id?: string; type?: string; tool?: string; input?: JsonObject; context?: JsonObject };
  try { message = JSON.parse(line) as typeof message; }
  catch { return; }
  if (!message.id) return;
  try {
    if (message.type === "ping") return send({ id: message.id, ok: true, result: "pong" });
    const tool = message.tool ? tools.get(message.tool) : undefined;
    if (!tool) throw new Error("Plugin tool not found");
    if (message.type === "approval") {
      const result = typeof tool.requiresApproval === "function"
        ? await tool.requiresApproval(message.input ?? {})
        : Boolean(tool.requiresApproval);
      return send({ id: message.id, ok: true, result: Boolean(result) });
    }
    if (message.type === "execute") {
      const result = await tool.execute(message.input ?? {}, message.context ?? {});
      return send({ id: message.id, ok: true, result: typeof result === "string" ? result : JSON.stringify(result ?? {}) });
    }
    throw new Error("Unknown plugin host request");
  } catch (error) {
    send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function send(value: unknown): void {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Plugin host response is too large");
  process.stdout.write(`${line}\n`);
}
