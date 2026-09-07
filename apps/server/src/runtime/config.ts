import { chmod, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import type { AuthMode } from "../app";

const LOOPBACK_NAMES = new Set(["localhost", "::1", "[::1]"]);
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 300_000;
const CONFIG_KEYS = new Set([
  "host",
  "port",
  "dataDir",
  "authMode",
  "trustProxy",
  "serveWeb",
  "shutdownTimeoutMs",
  "buildId"
]);

export const DEFAULT_RUNTIME_CONFIG = {
  host: "127.0.0.1",
  port: 3000,
  dataDir: "./data",
  authMode: "password",
  trustProxy: false,
  serveWeb: true,
  shutdownTimeoutMs: 30_000,
  buildId: "development"
} as const;

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  authMode: AuthMode;
  trustProxy: boolean | string;
  serveWeb: boolean;
  shutdownTimeoutMs: number;
  buildId: string;
  webRoot: string;
}

export interface RuntimeConfigSelection {
  configPath: string;
  remainingArgs: string[];
}

export interface LoadedRuntimeConfig {
  config: RuntimeConfig;
  configPath: string;
  generated: boolean;
}

export function selectRuntimeConfig(
  args: string[],
  projectRoot: string,
  cwd = process.cwd()
): RuntimeConfigSelection {
  let configuredPath: string | undefined;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--config") {
      remainingArgs.push(argument);
      continue;
    }
    if (configuredPath !== undefined) throw new Error("--config 只能指定一次");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--config 后必须提供配置文件路径");
    configuredPath = resolve(cwd, value);
    index += 1;
  }
  return {
    configPath: configuredPath ?? resolve(projectRoot, "config.json"),
    remainingArgs
  };
}

export async function loadRuntimeConfig(
  configPath: string,
  projectRoot: string,
  createIfMissing: boolean
): Promise<LoadedRuntimeConfig> {
  let source: string;
  let generated = false;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT") || !createIfMissing) {
      throw new Error(`无法读取配置文件 (${configPath}): ${formatError(error)}`, { cause: error });
    }
    source = `${JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2)}\n`;
    try {
      await writeFile(configPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try { await chmod(configPath, 0o600); } catch {}
      generated = true;
    } catch (writeError) {
      if (!isNodeError(writeError, "EEXIST")) {
        throw new Error(`无法生成默认配置文件 (${configPath}): ${formatError(writeError)}`, { cause: writeError });
      }
      try {
        source = await readFile(configPath, "utf8");
      } catch (readError) {
        throw new Error(`无法读取并发生成的配置文件 (${configPath}): ${formatError(readError)}`, { cause: readError });
      }
    }
  }

  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`配置文件不是有效 JSON (${configPath}): ${formatError(error)}`, { cause: error });
  }
  return {
    config: parseRuntimeConfig(document, configPath, projectRoot),
    configPath,
    generated
  };
}

export function parseRuntimeConfig(
  document: unknown,
  configPath: string,
  projectRoot: string
): RuntimeConfig {
  if (!isRecord(document)) throw new Error("配置文件根节点必须是 JSON 对象");
  const unknownKeys = Object.keys(document).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length) throw new Error(`配置文件包含未知字段：${unknownKeys.join("、")}`);

  const host = optionalString(document.host, "host", DEFAULT_RUNTIME_CONFIG.host);
  const port = optionalInteger(document.port, "port", DEFAULT_RUNTIME_CONFIG.port, 1, 65_535);
  const configuredDataDir = optionalString(document.dataDir, "dataDir", DEFAULT_RUNTIME_CONFIG.dataDir);
  const authMode = optionalAuthMode(document.authMode);
  const trustProxy = optionalTrustProxy(document.trustProxy);
  const serveWeb = optionalBoolean(document.serveWeb, "serveWeb", DEFAULT_RUNTIME_CONFIG.serveWeb);
  const shutdownTimeoutMs = optionalInteger(
    document.shutdownTimeoutMs,
    "shutdownTimeoutMs",
    DEFAULT_RUNTIME_CONFIG.shutdownTimeoutMs,
    MIN_SHUTDOWN_TIMEOUT_MS,
    MAX_SHUTDOWN_TIMEOUT_MS
  );
  const buildId = optionalString(document.buildId, "buildId", DEFAULT_RUNTIME_CONFIG.buildId, 200);

  if (authMode === "disabled" && !isLoopbackHostname(host)) {
    throw new Error("authMode=disabled 仅允许回环监听地址");
  }
  return {
    host,
    port,
    dataDir: resolve(dirname(configPath), configuredDataDir),
    authMode,
    trustProxy,
    serveWeb,
    shutdownTimeoutMs,
    buildId,
    webRoot: resolve(projectRoot, "apps/web/dist")
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(normalized)) return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function optionalString(value: unknown, name: string, fallback: string, maxLength?: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`配置项 ${name} 必须是非空单行字符串`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new Error(`配置项 ${name} 长度不能超过 ${maxLength} 个字符`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`配置项 ${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`配置项 ${name} 必须是布尔值`);
  return value;
}

function optionalAuthMode(value: unknown): AuthMode {
  if (value === undefined) return DEFAULT_RUNTIME_CONFIG.authMode;
  if (value !== "password" && value !== "disabled") {
    throw new Error("配置项 authMode 必须是 password 或 disabled");
  }
  return value;
}

function optionalTrustProxy(value: unknown): boolean | string {
  if (value === undefined) return DEFAULT_RUNTIME_CONFIG.trustProxy;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim() && !/[\0\r\n]/.test(value)) return value;
  throw new Error("配置项 trustProxy 必须是布尔值或非空单行字符串");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
