import { createInterface } from "node:readline";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import {
  createPluginRegistry,
  describePluginTools,
  handlePluginLine,
  serializeHostMessage,
  type JsonObject,
  type PluginApi
} from "./plugin-host-runtime";

const entry = process.argv[2];
if (!entry) throw new Error("Plugin entry is required");
const input = createInterface({ input: process.stdin });
const [initialLine] = await once(input, "line") as [string];
if (Buffer.byteLength(initialLine) > 8 * 1024 * 1024) throw new Error("Plugin initialization is too large");
const initialization = JSON.parse(initialLine) as { type?: string; config?: JsonObject; secrets?: JsonObject };
if (initialization.type !== "initialize") throw new Error("Plugin initialization is required");
const config = initialization.config ?? {};
const secrets = initialization.secrets ?? {};

const { api, tools } = createPluginRegistry(config, secrets);

const imported = await import(`${pathToFileURL(entry).href}?host=${Date.now()}`) as {
  default?: (api: PluginApi) => unknown;
  register?: (api: PluginApi) => unknown;
};
const register = imported.register ?? imported.default;
if (typeof register !== "function") throw new Error("Plugin must export register(api) or a default registration function");
await register(api);
send({ type: "ready", tools: describePluginTools(tools) });

input.on("line", (line) => {
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) return process.exit(70);
  void handlePluginLine(tools, line).then((response) => { if (response) send(response); });
});

function send(value: unknown): void {
  process.stdout.write(serializeHostMessage(value));
}
