import { isIP } from "node:net";
import { resolve } from "node:path";
import type { AuthMode } from "../app";

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]"]);
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  authMode: AuthMode;
  trustProxy: boolean | string;
  publicUrl: string;
  serveWeb: boolean;
  shutdownTimeoutMs: number;
  buildId: string;
  webRoot: string;
}

export function parseRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd()
): RuntimeConfig {
  const host = env.LLM_CHAT_HOST ?? "127.0.0.1";
  const port = parsePort(env.LLM_CHAT_PORT ?? "3000");
  const dataDir = resolve(env.LLM_CHAT_DATA_DIR ?? resolve(projectRoot, "data"));
  const authMode = parseAuthMode(env.LLM_CHAT_AUTH_MODE ?? "password");
  const trustProxySetting = env.LLM_CHAT_TRUST_PROXY;
  const trustProxy = trustProxySetting === "true"
    ? true
    : trustProxySetting && trustProxySetting !== "false" ? trustProxySetting : false;
  const configuredPublicUrl = env.LLM_CHAT_PUBLIC_URL;

  const publicUrl = configuredPublicUrl ?? `http://localhost:${port}`;
  const parsedPublicUrl = parsePublicUrl(publicUrl);
  if (authMode === "disabled" && (!isLoopbackHostname(host) || !isLoopbackHostname(parsedPublicUrl.hostname))) {
    throw new Error("LLM_CHAT_AUTH_MODE=disabled 仅允许回环监听地址和回环公开地址");
  }
  return {
    host,
    port,
    dataDir,
    authMode,
    trustProxy,
    publicUrl,
    serveWeb: parseBoolean(env.LLM_CHAT_SERVE_WEB, "LLM_CHAT_SERVE_WEB", true),
    shutdownTimeoutMs: parseBoundedInteger(
      env.LLM_CHAT_SHUTDOWN_TIMEOUT_MS,
      "LLM_CHAT_SHUTDOWN_TIMEOUT_MS",
      30_000,
      MIN_SHUTDOWN_TIMEOUT_MS,
      MAX_SHUTDOWN_TIMEOUT_MS
    ),
    buildId: parseBuildId(env.LLM_CHAT_BUILD_ID),
    webRoot: resolve(projectRoot, "apps/web/dist")
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(normalized)) return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LLM_CHAT_PORT 必须是有效端口");
  }
  return port;
}

function parseAuthMode(value: string): AuthMode {
  if (value !== "password" && value !== "disabled") {
    throw new Error("LLM_CHAT_AUTH_MODE 必须是 password 或 disabled");
  }
  return value;
}

function parsePublicUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("LLM_CHAT_PUBLIC_URL 必须是有效 URL");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("LLM_CHAT_PUBLIC_URL 只能包含协议、主机和端口");
  }
  return parsed;
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} 必须是整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须介于 ${minimum} 和 ${maximum} 之间`);
  }
  return parsed;
}

function parseBuildId(value: string | undefined): string {
  if (value === undefined) return "development";
  if (!value.trim() || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error("LLM_CHAT_BUILD_ID 必须是 1 到 200 个字符的单行文本");
  }
  return value;
}
