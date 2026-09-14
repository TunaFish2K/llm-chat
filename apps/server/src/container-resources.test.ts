import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { containerResourceDefinitionSchema, pluginManifestSchema, type ContainerEngine, type ContainerResourceDefinition, type ContainerResourceFile } from "@llm-chat/contracts";
import { ContainerResourceFiles, waitForResource } from "./container-resource-files";
import { ContainerResources } from "./container-resources";
import { registerContainerResourceRoutes } from "./container-resource-routes";
import { Store } from "./database";
import { EventHub } from "./events";
import type { EngineAdapter } from "./container-engine";
import { PluginManager } from "./plugins";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const file = (name: string, contents = name): ContainerResourceFile => ({ name, sha256: sha(contents), size: Buffer.byteLength(contents), url: `https://example.org/${name}`, mirrors: { ustc: `https://mirrors.ustc.edu.cn/${name}`, tuna: `https://mirrors.tuna.tsinghua.edu.cn/${name}` } });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "llm-chat-resource-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true })); return path;
}
function definition(id: string, dependencies: string[] = []): ContainerResourceDefinition {
  return { id, name: id, description: "", version: "1", dependencies, variants: [{ platform: "linux/amd64", distro: "alpine-3.24", files: [file(`${id}.apk`)], install: "true", verify: "true" }] };
}
async function fixture() {
  const dir = await directory(); const store = new Store(join(dir, "db.sqlite"));
  const calls: string[][] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).pathname.slice(1)));
  vi.stubGlobal("fetch", fetcher);
  const adapter = (engine: ContainerEngine): EngineAdapter => ({ engine,
    command(args) { calls.push(args); return { executable: process.execPath, args: ["-e", "process.exit(0)"] }; },
    async probe() { return { engine, available: true, version: "test", error: null }; },
    async run(args) { return args[0] === "image" ? JSON.stringify([{ Id: args[2]!.startsWith("sha256:") ? args[2] : `sha256:${sha(args[2]!)}` }]) : ""; }
  });
  const engines = { docker: adapter("docker"), podman: adapter("podman") };
  const builtins = [definition("alpine"), definition("runtime", ["alpine"]), definition("tools", ["runtime"])];
  const events = new EventHub(); const resources = new ContainerResources(store, events, engines, builtins);
  await resources.initialize();
  cleanups.push(async () => { await resources.close(); store.close(); });
  return { dir, store, resources, calls, fetcher, engines, events, builtins };
}

describe("resource downloads", () => {
  it("resumes a partial file, verifies it and shares the cached result", async () => {
    const dir = await directory(), artifact = file("asset", "abcdef");
    await writeFile(join(dir, artifact.sha256 + ".part"), "abc");
    const fetcher = vi.fn(async () => new Response("def", { status: 206, headers: { "content-range": "bytes 3-5/6" } }));
    const files = new ContainerResourceFiles(dir, fetcher as typeof fetch);
    await files.ensure(artifact, artifact.url, new AbortController().signal, () => {});
    expect(fetcher.mock.calls[0]).toBeDefined();
    expect(await readFile(files.path(artifact.sha256), "utf8")).toBe("abcdef");
    await files.ensure(artifact, artifact.url, new AbortController().signal, () => {});
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await files.bytes()).toBe(6);
    expect(() => files.path("../../bad")).toThrow("digest"); await files.close();
  });
  it("restarts when ranges are ignored and rejects invalid content without caching it", async () => {
    const dir = await directory(), artifact = file("asset", "abcdef");
    await writeFile(join(dir, artifact.sha256 + ".part"), "abc");
    const fetcher = vi.fn(async () => new Response("abcdef"));
    const files = new ContainerResourceFiles(dir, fetcher as typeof fetch);
    await files.ensure(artifact, artifact.url, new AbortController().signal, () => {});
    expect(await files.has(artifact)).toBe(true);
    await rm(files.path(artifact.sha256)); fetcher.mockImplementation(async () => new Response("xxxxxx"));
    await expect(files.ensure(artifact, artifact.url, new AbortController().signal, () => {})).rejects.toThrow("checksum");
    expect(await files.has(artifact)).toBe(false);
    fetcher.mockImplementation(async () => new Response("too much data"));
    await expect(files.ensure(artifact, artifact.url, new AbortController().signal, () => {})).rejects.toThrow("size");
    fetcher.mockImplementation(async () => new Response("", { status: 500 }));
    await expect(files.ensure(artifact, artifact.url, new AbortController().signal, () => {})).rejects.toThrow("HTTP 500");
    await files.close();
  });
  it("cancels one waiter without cancelling another shared download", async () => {
    const dir = await directory(), artifact = file("asset");
    let release!: () => void;
    const fetcher = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return new Response("asset"); });
    const files = new ContainerResourceFiles(dir, fetcher as typeof fetch);
    const controller = new AbortController();
    const first = files.ensure(artifact, artifact.url, controller.signal, () => {}).catch(error => error);
    const second = files.ensure(artifact, artifact.url, new AbortController().signal, () => {});
    await expect.poll(() => fetcher.mock.calls.length).toBe(1);
    controller.abort(new Error("Cancelled waiter")); expect(await first).toBeInstanceOf(Error);
    release(); await second; expect(await files.has(artifact)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1); await files.close();
  });
  it("rejects malformed ranges and restarts an expired range", async () => {
    const dir = await directory(), artifact = file("asset", "abcdef");
    await writeFile(join(dir, artifact.sha256 + ".part"), "abc");
    const fetcher = vi.fn(async () => new Response("def", { status: 206, headers: { "content-range": "bytes 1-3/6" } }));
    const files = new ContainerResourceFiles(dir, fetcher as typeof fetch);
    await expect(files.ensure(artifact, artifact.url, new AbortController().signal, () => {})).rejects.toThrow("range");
    fetcher.mockImplementationOnce(async () => new Response("", { status: 416 })).mockImplementation(async () => new Response("abcdef"));
    await files.ensure(artifact, artifact.url, new AbortController().signal, () => {});
    expect(await files.has(artifact)).toBe(true); await files.close();
    await expect(waitForResource(Promise.reject(new Error("failed")), new AbortController().signal)).rejects.toThrow("failed");
    expect(await waitForResource(Promise.resolve(4))).toBe(4);
  });
});

describe("resource management", () => {
  it("downloads dependency closures with the chosen node and retries after failures", async () => {
    const { resources, fetcher } = await fixture();
    expect(resources.node()).toBe("ustc");
    resources.setNode("tuna");
    const job = resources.download(["builtin:tools"]);
    expect(resources.download(["builtin:tools"]).id).toBe(job.id);
    await expect.poll(() => resources.jobs()[0]?.state).toBe("complete");
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://mirrors.tuna.tsinghua.edu.cn/"))).toBe(true);
    const catalog = await resources.catalog(); expect(catalog.resources.every(r => r.files.every(f => f.cached))).toBe(true);
    expect(catalog.cacheBytes).toBeGreaterThan(0);
    await resources.clearCache(); resources.setNode("official");
    fetcher.mockImplementation(async () => new Response("", { status: 500 })); resources.download(["builtin:alpine"]);
    await expect.poll(() => resources.jobs()[0]?.state).toBe("error");
    expect(resources.jobs()[0]?.error).toContain("HTTP 500");
    expect((await resources.catalog()).resources[0]?.files[0]?.downloadUrl).toBe("https://example.org/alpine.apk");
  });
  it("prepares once concurrently, shares installed layers and reuses images after clearing downloads", async () => {
    const { resources, calls, fetcher } = await fixture();
    const lock = resources.lock();
    const [first, second] = await Promise.all([resources.prepare("docker", lock), resources.prepare("docker", lock)]);
    expect(first).toBe(second); expect(calls.filter(args => args[0] === "import")).toHaveLength(1);
    expect(calls.filter(args => args[0] === "run")).toHaveLength(2);
    expect(calls.filter(args => args[0] === "run").every(args => args.includes("none") && args.includes("/bin/sh"))).toBe(true);
    const downloaded = fetcher.mock.calls.length;
    await resources.clearCache(); expect(await resources.prepare("docker", lock)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(downloaded);
    await resources.prepare("podman", lock); expect(calls.some(args => args.includes("--arch"))).toBe(true);
  });
  it("serializes different combinations and preserves a frozen plugin resource after unloading", async () => {
    const { dir, store, resources, calls, events } = await fixture();
    const source = join(dir, "plugin"); await mkdir(source);
    const manifest = { id: "software", name: "Software", version: "1", apiVersion: 1, containerResources: [definition("extra", ["builtin:runtime"])] };
    await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
    const plugins = new PluginManager(store, events); cleanups.push(async () => plugins.close());
    const installed = await plugins.install(source); expect(installed.state).toBe("loaded"); expect(await plugins.tools()).toEqual([]);
    const lock = resources.lock(["plugin:software:extra"]);
    manifest.containerResources[0]!.version = "2";
    await writeFile(join(source, "plugin.json"), JSON.stringify(manifest));
    await plugins.reload("software");
    expect(resources.lock(["plugin:software:extra"]).at(-1)?.definition.version).toBe("2");
    expect(resources.lock(["plugin:software:extra"], { software: installed.revision }).at(-1)?.definition.version).toBe("1");
    plugins.unload("software"); expect(resources.definitions().some(r => r.id === "plugin:software:extra")).toBe(false);
    await Promise.all([resources.prepare("docker", lock), resources.prepare("docker", resources.lock())]);
    expect(calls.filter(args => args[0] === "import")).toHaveLength(1);
    expect(calls.filter(args => args[0] === "run")).toHaveLength(3);
    await plugins.reload("software"); await plugins.remove("software");
    expect(await resources.prepare("docker", lock)).toMatch(/^sha256:/);
  });
  it("reports unsupported resources, cycles and installation failures", async () => {
    const { resources, builtins, engines, calls } = await fixture();
    expect(() => resources.resolve(["missing"])).toThrow("unavailable");
    builtins.push(definition("cycle", ["cycle"])); expect(() => resources.resolve(["builtin:cycle"])).toThrow("cycle");
    const other = definition("arm"); other.variants[0]!.platform = "linux/arm64"; builtins.push(other);
    expect(() => resources.resolve(["builtin:arm"])).toThrow("platform");
    engines.docker.command = args => { calls.push(args); return { executable: process.execPath, args: ["-e", "console.error('install broke');process.exit(1)"] }; };
    await expect(resources.prepare("docker", resources.lock())).rejects.toThrow("install broke");
    expect(resources.jobs()[0]?.state).toBe("error");
    engines.docker.probe = async () => ({ engine: "docker", available: false, error: "No engine", version: null });
    await expect(resources.prepare("docker", resources.lock())).rejects.toThrow("No engine");
  });
  it("cancels a global job, prevents cache removal while running and recovers interrupted jobs", async () => {
    const { resources, fetcher, store } = await fixture();
    fetcher.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return new Response("alpine.apk"); });
    const job = resources.download(["builtin:alpine"]);
    await expect(resources.clearCache()).rejects.toThrow("Finish or cancel");
    resources.cancel(job.id); await expect.poll(() => resources.jobs()[0]?.state).toBe("cancelled");
    store.sqlite.prepare("INSERT INTO container_resource_jobs VALUES (?,?)").run("interrupted", JSON.stringify({ ...job, id: "interrupted", state: "running" }));
    await resources.initialize(); expect(resources.jobs()[0]?.error).toContain("interrupted");
    await resources.close(); expect(() => resources.download(["builtin:alpine"])).toThrow("closing");
  });
  it("preserves existing cache and removes legacy upload files and records only when clearing cache", async () => {
    const { resources, dir, store } = await fixture();
    const artifact = file("runtime.apk");
    await mkdir(resources.files.directory, { recursive: true });
    await writeFile(resources.files.path(artifact.sha256), "runtime.apk");
    const uploads = join(dir, "container-resources", "uploads");
    await mkdir(uploads, { recursive: true });
    await writeFile(join(uploads, "legacy"), "runtime");
    await writeFile(join(uploads, "orphan"), "partial");
    store.sqlite.prepare("INSERT INTO container_resource_uploads VALUES (?,?,?,?)").run("legacy", "file:old", 11, 7);
    await resources.initialize();
    expect(await resources.files.has(artifact)).toBe(true);
    expect(await readFile(join(uploads, "legacy"), "utf8")).toBe("runtime");
    expect(store.sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 46 });
    await resources.clearCache();
    expect(await resources.files.has(artifact)).toBe(false);
    await expect(readFile(join(uploads, "orphan"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.sqlite.prepare("SELECT * FROM container_resource_uploads").all()).toEqual([]);
    await resources.clearCache();
  });
  it("exposes download routes and returns 404 for removed offline import and export routes", async () => {
    const { resources } = await fixture();
    const app = Fastify();
    registerContainerResourceRoutes(app, resources); cleanups.push(() => app.close());
    expect((await app.inject({ method: "GET", url: "/api/container-resources" })).json().node).toBe("ustc");
    expect((await app.inject({ method: "PUT", url: "/api/container-resources/settings", payload: { node: "official" } })).statusCode).toBe(200);
    const started = await app.inject({ method: "POST", url: "/api/container-resources/download", payload: { ids: ["builtin:tools"] } });
    expect(started.json().kind).toBe("download"); await expect.poll(() => resources.jobs()[0]?.state).toBe("complete");
    expect((await app.inject({ method: "GET", url: "/api/container-resources/bundle?ids=builtin:tools" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/container-resources/uploads", payload: { name: "runtime.apk", size: 11 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/container-resources/uploads/old?offset=0" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/container-resources/uploads/old/complete" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/container-resources/jobs/${started.json().id}/cancel` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/container-resources/cache" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/container-resources/download", payload: { ids: ["missing"] } })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

it("validates resource-only manifests and rejects duplicate resources and unapproved mirror hosts", () => {
  expect(pluginManifestSchema.safeParse({ id: "software", name: "Software", version: "1", apiVersion: 1, containerResources: [definition("extra")] }).success).toBe(true);
  expect(pluginManifestSchema.safeParse({ id: "empty", name: "Empty", version: "1", apiVersion: 1 }).success).toBe(false);
  const duplicate = definition("extra"); duplicate.variants.push(duplicate.variants[0]!);
  expect(containerResourceDefinitionSchema.safeParse(duplicate).success).toBe(false);
  const badMirror = definition("extra"); badMirror.variants[0]!.files[0]!.mirrors = { tuna: "https://other.example/asset" };
  expect(containerResourceDefinitionSchema.safeParse(badMirror).success).toBe(false);
});
