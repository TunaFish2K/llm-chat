import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  loadRuntimeConfig,
  parseRuntimeConfig,
  selectRuntimeConfig
} from "./config";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const projectRoot = "/srv/llm-chat";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
      webRoot: "/srv/llm-chat/apps/web/dist"
    });
    expect(parseRuntimeConfig({
      host: "0.0.0.0",
      port: 4321,
      dataDir: "/srv/chat-data"
    }, "/etc/llm-chat/config.json", projectRoot)).toMatchObject({
      host: "0.0.0.0",
      port: 4321,
      dataDir: "/srv/chat-data"
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

  it("never exposes an unfinished default file to another creator", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    const originalWrite = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
    let opened!: () => void;
    let finish!: () => void;
    const emptyFileCreated = new Promise<void>((resolve) => { opened = resolve; });
    const resumeWrite = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(fs.writeFile).mockImplementationOnce(async (file, data, options) => {
      await originalWrite(file, "", options);
      opened();
      await resumeWrite;
      await originalWrite(file, data, { encoding: "utf8", flag: "w", mode: 0o600 });
    });
    const first = loadRuntimeConfig(configPath, projectRoot, true);
    try {
      await emptyFileCreated;
      const second = await loadRuntimeConfig(configPath, projectRoot, true);
      expect(second.generated).toBe(true);
      expect(second.config.port).toBe(DEFAULT_RUNTIME_CONFIG.port);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(DEFAULT_RUNTIME_CONFIG);
      finish();
      expect((await first).generated).toBe(false);
      expect(await fs.readdir(directory)).toEqual(["config.json"]);
    } finally {
      finish();
      await first;
    }
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
    for (const value of [0, 65_536, 1.5, "3000", null]) {
      expect(() => parseRuntimeConfig({ port: value }, "/config.json", projectRoot)).toThrow("port");
    }
    expect(() => parseRuntimeConfig({ dataDir: "" }, "/config.json", projectRoot)).toThrow("dataDir");
    expect(() => parseRuntimeConfig({ extra: true }, "/config.json", projectRoot)).toThrow("未知字段");
    expect(() => parseRuntimeConfig([], "/config.json", projectRoot)).toThrow("JSON 对象");
  });

  it.each(["authMode", "trustProxy", "serveWeb", "shutdownTimeoutMs", "buildId"])("explains how to remove retired configuration %s", (key) => {
    expect(() => parseRuntimeConfig({ [key]: false }, "/config.json", projectRoot))
      .toThrow(`配置项已移除，请从配置文件删除：${key}`);
  });
});
