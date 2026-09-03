import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  isLoopbackHostname,
  loadRuntimeConfig,
  parseRuntimeConfig,
  selectRuntimeConfig
} from "./config";

const projectRoot = "/srv/llm-chat";
const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "llm-chat-config-"));
  tempDirs.push(directory);
  return directory;
}

describe("runtime config", () => {
  it("parses defaults and resolves data relative to the config file", () => {
    expect(parseRuntimeConfig({}, "/etc/llm-chat/config.json", projectRoot)).toEqual({
      host: "127.0.0.1",
      port: 3000,
      dataDir: "/etc/llm-chat/data",
      authMode: "password",
      trustProxy: false,
      serveWeb: true,
      shutdownTimeoutMs: 30_000,
      buildId: "development",
      webRoot: "/srv/llm-chat/apps/web/dist"
    });
    expect(parseRuntimeConfig({
      host: "0.0.0.0",
      port: 4321,
      dataDir: "/srv/chat-data",
      authMode: "password",
      trustProxy: "127.0.0.1",
      serveWeb: false,
      shutdownTimeoutMs: 15_000,
      buildId: "release-42"
    }, "/etc/llm-chat/config.json", projectRoot)).toMatchObject({
      host: "0.0.0.0",
      port: 4321,
      dataDir: "/srv/chat-data",
      trustProxy: "127.0.0.1",
      serveWeb: false,
      shutdownTimeoutMs: 15_000,
      buildId: "release-42"
    });
  });

  it("selects the default or explicit config path and preserves other arguments", () => {
    expect(selectRuntimeConfig([], projectRoot, "/work")).toEqual({
      configPath: "/srv/llm-chat/config.json",
      remainingArgs: []
    });
    expect(selectRuntimeConfig(
      ["--confirm-reset-password", "--config", "deploy/config.json"],
      projectRoot,
      "/work"
    )).toEqual({
      configPath: "/work/deploy/config.json",
      remainingArgs: ["--confirm-reset-password"]
    });
    expect(() => selectRuntimeConfig(["--config"], projectRoot)).toThrow("必须提供");
    expect(() => selectRuntimeConfig(["--config", "a", "--config", "b"], projectRoot)).toThrow("只能指定一次");
  });

  it("generates a complete default config without overwriting it later", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    const first = await loadRuntimeConfig(configPath, projectRoot, true);
    expect(first.generated).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(DEFAULT_RUNTIME_CONFIG);

    await writeFile(configPath, '{\n  "port": 4100\n}\n');
    const second = await loadRuntimeConfig(configPath, projectRoot, true);
    expect(second.generated).toBe(false);
    expect(second.config.port).toBe(4100);
    expect(await readFile(configPath, "utf8")).toBe('{\n  "port": 4100\n}\n');
  });

  it("keeps the deployment example aligned with generated defaults", async () => {
    const example = JSON.parse(await readFile(join(process.cwd(), "config.example.json"), "utf8"));
    expect(example).toEqual(DEFAULT_RUNTIME_CONFIG);
  });

  it.skipIf(process.platform === "win32")("creates the default config with owner-only permissions", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    await loadRuntimeConfig(configPath, projectRoot, true);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("handles concurrent default generation with one shared valid file", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    const results = await Promise.all([
      loadRuntimeConfig(configPath, projectRoot, true),
      loadRuntimeConfig(configPath, projectRoot, true)
    ]);
    expect(results.filter((result) => result.generated)).toHaveLength(1);
    expect(results[0]!.config).toEqual(results[1]!.config);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(DEFAULT_RUNTIME_CONFIG);
  });

  it("does not create missing maintenance config or a missing parent directory", async () => {
    const directory = await temporaryDirectory();
    await expect(loadRuntimeConfig(join(directory, "missing.json"), projectRoot, false))
      .rejects.toThrow("无法读取配置文件");
    await expect(loadRuntimeConfig(join(directory, "missing", "config.json"), projectRoot, true))
      .rejects.toThrow("无法生成默认配置文件");
  });

  it("rejects invalid existing files without replacing their contents", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    await writeFile(configPath, "{ invalid json");
    await expect(loadRuntimeConfig(configPath, projectRoot, true)).rejects.toThrow("不是有效 JSON");
    expect(await readFile(configPath, "utf8")).toBe("{ invalid json");
  });

  it("strictly validates document fields", () => {
    for (const value of [999, 300_001, 1.5, "15000", null]) {
      expect(() => parseRuntimeConfig({ shutdownTimeoutMs: value }, "/config.json", projectRoot))
        .toThrow("shutdownTimeoutMs");
    }
    for (const value of [0, 65_536, 1.5, "3000", null]) {
      expect(() => parseRuntimeConfig({ port: value }, "/config.json", projectRoot)).toThrow("port");
    }
    expect(() => parseRuntimeConfig({ serveWeb: "true" }, "/config.json", projectRoot)).toThrow("serveWeb");
    expect(() => parseRuntimeConfig({ trustProxy: "" }, "/config.json", projectRoot)).toThrow("trustProxy");
    expect(() => parseRuntimeConfig({ dataDir: "" }, "/config.json", projectRoot)).toThrow("dataDir");
    expect(() => parseRuntimeConfig({ buildId: "x".repeat(201) }, "/config.json", projectRoot)).toThrow("buildId");
    expect(() => parseRuntimeConfig({ extra: true }, "/config.json", projectRoot)).toThrow("未知字段");
    expect(() => parseRuntimeConfig([], "/config.json", projectRoot)).toThrow("JSON 对象");
  });

  it("allows disabled auth only on a loopback listener", () => {
    expect(parseRuntimeConfig(
      { authMode: "disabled", host: "127.0.0.2" },
      "/config.json",
      projectRoot
    ).authMode).toBe("disabled");
    expect(() => parseRuntimeConfig(
      { authMode: "disabled", host: "0.0.0.0" },
      "/config.json",
      projectRoot
    )).toThrow("仅允许回环");
    expect(() => parseRuntimeConfig({ authMode: "webauthn" }, "/config.json", projectRoot))
      .toThrow("password 或 disabled");
  });

  it("recognizes common IPv4 and IPv6 loopback hosts", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.255.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.999.0.1")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});
