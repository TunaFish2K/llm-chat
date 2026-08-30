import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";

const host = process.env.LLM_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.LLM_CHAT_PORT ?? "3000");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = process.env.LLM_CHAT_DATA_DIR ?? resolve(projectRoot, "data");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("LLM_CHAT_PORT 必须是有效端口");
}
if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  process.stderr.write("警告：服务正在监听非回环地址。请确保外部网关已经启用身份验证。\n");
}

const app = await buildApp({ dataFile: resolve(dataDir, "llm-chat.sqlite") });
await app.listen({ host, port });
