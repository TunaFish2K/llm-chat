import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type AuthMode } from "./app";

const host = process.env.LLM_CHAT_HOST ?? "127.0.0.1";
const port = Number(process.env.LLM_CHAT_PORT ?? "3000");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = process.env.LLM_CHAT_DATA_DIR ?? resolve(projectRoot, "data");
const authMode = (process.env.LLM_CHAT_AUTH_MODE ?? "webauthn") as AuthMode;
const trustProxySetting = process.env.LLM_CHAT_TRUST_PROXY;
const trustProxy = trustProxySetting === "true" ? true : trustProxySetting && trustProxySetting !== "false" ? trustProxySetting : false;
const configuredPublicUrl = process.env.LLM_CHAT_PUBLIC_URL;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("LLM_CHAT_PORT 必须是有效端口");
}
if (authMode !== "webauthn" && authMode !== "disabled") {
  throw new Error("LLM_CHAT_AUTH_MODE 必须是 webauthn 或 disabled");
}
if (authMode === "disabled" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  process.stderr.write("警告：认证已关闭且服务正在监听非回环地址。请勿将该地址暴露到不可信网络。\n");
}
if (authMode === "webauthn" && !loopbackHosts.has(host) && !configuredPublicUrl) {
  throw new Error("监听非本机地址时必须设置 LLM_CHAT_PUBLIC_URL=https://你的域名");
}

const publicUrl = configuredPublicUrl ?? `http://localhost:${port}`;
const parsedPublicUrl = new URL(publicUrl);
if (parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.pathname !== "/" || parsedPublicUrl.search || parsedPublicUrl.hash) {
  throw new Error("LLM_CHAT_PUBLIC_URL 只能包含协议、主机和端口");
}
if (authMode === "webauthn" && parsedPublicUrl.protocol !== "https:" && parsedPublicUrl.hostname !== "localhost") {
  throw new Error("WebAuthn 远程访问必须配置 HTTPS；本机调试请使用 http://localhost");
}
const rpId = process.env.LLM_CHAT_RP_ID ?? parsedPublicUrl.hostname;
if (parsedPublicUrl.hostname !== rpId && !parsedPublicUrl.hostname.endsWith(`.${rpId}`)) {
  throw new Error("LLM_CHAT_RP_ID 必须等于公开地址域名或它的父域名");
}

const app = await buildApp({
  dataFile: resolve(dataDir, "llm-chat.sqlite"),
  authMode,
  trustProxy,
  publicUrl,
  rpId
});
await app.listen({ host, port });
