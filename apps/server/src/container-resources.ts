import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, link, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { containerResourceDefinitionSchema, pluginManifestSchema, type ContainerEngine, type ContainerResourceCatalog, type ContainerResourceFile, type ContainerResourceJob, type ContainerResourceNode, type ContainerResourceRevision } from "@llm-chat/contracts";
import type { Store } from "./database";
import type { EventHub } from "./events";
import { LocalContainerEngine, type EngineAdapter } from "./container-engine";
import { ContainerResourceFiles, waitForResource } from "./container-resource-files";
import builtinLock from "./container-resource-lock.json";

export const ALPINE_IMAGE = "llm-chat-runtime:alpine";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const mount = (source: string, target: string) => [`type=bind`, `src=${source}`, `dst=${target}`, "readonly"].map(s => /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s).join(",");
type JobRun = { controller: AbortController; promise: Promise<void>; job: ContainerResourceJob };

export class ContainerResources {
  readonly files: ContainerResourceFiles;
  readonly platform = process.arch === "x64" ? "linux/amd64" : process.arch === "arm64" ? "linux/arm64" : `linux/${process.arch}`;
  private readonly running = new Map<string, JobRun>();
  private closing = false;
  private clearingCache = false;
  private readonly preparationQueues = new Map<ContainerEngine, Promise<void>>();
  private readonly root: string;
  private readonly owner: string;
  constructor(private readonly store: Store, private readonly events: EventHub,
    private readonly engines: Record<ContainerEngine, EngineAdapter> = { docker: new LocalContainerEngine("docker"), podman: new LocalContainerEngine("podman") },
    private readonly builtins: unknown[] = builtinLock) {
    this.root = join(store.dataDir, "container-resources");
    this.files = new ContainerResourceFiles(join(this.root, "files"));
    this.owner = digest(resolve(store.dataDir)).slice(0, 24);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const job of this.jobs()) if (job.state === "running") this.save({ ...job, state: "error", error: "Preparation interrupted; retry to resume cached downloads" });
    // Only remove this application's abandoned preparation containers.
    for (const engine of Object.values(this.engines)) {
      try {
        const ids = await engine.run(["ps", "-aq", "--filter", `label=fish.2kb.llm-chat.resource-owner=${this.owner}`]);
        for (const id of ids.split(/\s+/).filter(Boolean)) await engine.run(["rm", "-f", id]);
      } catch { /* Engines are optional; availability is shown in settings. */ }
    }
    for (const name of await readdir(this.root)) if (name.startsWith("prepare-")) await rm(join(this.root, name), { recursive: true, force: true });
    this.definitions();
  }
  node(): ContainerResourceNode {
    return (this.store.sqlite.prepare("SELECT node FROM container_resource_settings WHERE id=1").get() as { node: ContainerResourceNode }).node;
  }
  setNode(node: ContainerResourceNode) {
    this.store.sqlite.prepare("UPDATE container_resource_settings SET node=? WHERE id=1").run(node);
    this.events.emit({ type: "resource-changed", resource: "container-resources" });
  }
  definitions(pluginPins?: Record<string, string>): ContainerResourceRevision[] {
    const values: ContainerResourceRevision[] = [];
    const add = (prefix: string, source: string, revision: string, raw: unknown) => {
      const definition = containerResourceDefinitionSchema.parse(raw);
      if (new Set(definition.variants.map(v => v.platform)).size !== definition.variants.length) throw new Error("Duplicate resource platform");
      for (const variant of definition.variants) {
        if (new Set(variant.files.map(f => f.name)).size !== variant.files.length) throw new Error("Duplicate resource filename");
        for (const file of variant.files) for (const [node, url] of Object.entries(file.mirrors ?? {})) {
          if (url && !url.startsWith(node === "tuna" ? "https://mirrors.tuna.tsinghua.edu.cn/" : "https://mirrors.ustc.edu.cn/")) throw new Error("Unsupported resource mirror");
        }
      }
      definition.dependencies = definition.dependencies.map(id => id.includes(":") ? id : `${prefix}:${id}`);
      const value = { id: `${prefix}:${definition.id}`, source, revision: digest([revision, definition]), definition };
      this.store.sqlite.prepare("INSERT OR IGNORE INTO container_resource_revisions VALUES (?,?,?)").run(value.id, value.revision, JSON.stringify(value));
      values.push(value);
    };
    for (const item of this.builtins) add("builtin", "builtin", "1", item);
    const plugins = pluginPins ? Object.entries(pluginPins).map(([id, revision]) => {
      const row = this.store.sqlite.prepare("SELECT path FROM plugin_revisions WHERE plugin_id=? AND revision=?").get(id, revision);
      if (!row) throw new Error(`Pinned plugin revision is unavailable: ${id}`);
      return { id, active_revision: revision, manifest_json: readFileSync(join(String(row.path), "plugin.json"), "utf8") };
    }) : this.store.sqlite.prepare("SELECT id,manifest_json,active_revision FROM plugin_installations WHERE state IN ('loaded','pending-reload')").all();
    for (const row of plugins) {
      const manifest = pluginManifestSchema.parse(JSON.parse(String(row.manifest_json)));
      for (const resource of manifest.containerResources) add(`plugin:${row.id}`, String(row.id), String(row.active_revision), resource);
    }
    return values;
  }
  resolve(ids: string[], catalog = this.definitions()): ContainerResourceRevision[] {
    const found: ContainerResourceRevision[] = [];
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (found.some(item => item.id === id)) return;
      if (visiting.has(id)) throw new Error(`Resource dependency cycle: ${id}`);
      const item = catalog.find(value => value.id === id);
      if (!item) throw new Error(`Resource is unavailable: ${id}`);
      if (!item.definition.variants.some(v => v.platform === this.platform)) throw new Error(`Unsupported resource platform: ${id} (${this.platform})`);
      visiting.add(id);
      for (const dependency of [...item.definition.dependencies].sort()) visit(dependency);
      visiting.delete(id); found.push(item);
    };
    [...new Set(ids.some(id => id !== "builtin:alpine") ? ["builtin:runtime", ...ids] : ids)].sort().forEach(visit);
    return found;
  }
  lock(ids: string[] = ["builtin:tools"], pluginPins?: Record<string, string>) { return this.resolve(["builtin:runtime", ...ids], this.definitions(pluginPins)); }
  private variant(resource: ContainerResourceRevision) {
    const variant = resource.definition.variants.find(v => v.platform === this.platform);
    if (!variant) throw new Error(`Unsupported resource platform: ${resource.id}`);
    return variant;
  }
  resourceFiles(resources: ContainerResourceRevision[]) {
    return [...new Map(resources.flatMap(resource => this.variant(resource).files).map(file => [file.sha256, file])).values()];
  }
  private url(file: ContainerResourceFile) {
    const node = this.node();
    return node === "official" ? file.url : file.mirrors?.[node] ?? file.url;
  }
  async catalog(): Promise<ContainerResourceCatalog> {
    const definitions = this.definitions();
    return { node: this.node(), platform: this.platform, jobs: this.jobs(), cacheBytes: await this.files.bytes(), resources: await Promise.all(definitions.map(async resource => {
      try {
        const files = this.resourceFiles(this.resolve([resource.id], definitions));
        return { ...resource, available: true, files: await Promise.all(files.map(async file => ({ ...file, cached: await this.files.has(file), downloadUrl: this.url(file) }))) };
      } catch (error) { return { ...resource, available: false, availabilityError: message(error), files: [] }; }
    })) };
  }
  jobs(): ContainerResourceJob[] {
    return this.store.sqlite.prepare("SELECT value_json FROM container_resource_jobs ORDER BY rowid DESC LIMIT 100").all().map(row => JSON.parse(String(row.value_json)) as ContainerResourceJob);
  }
  private save(job: ContainerResourceJob) {
    job.updatedAt = Date.now();
    this.store.sqlite.prepare("INSERT INTO container_resource_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json").run(job.id, JSON.stringify(job));
    this.events.emit({ type: "container-resource", job: { ...job } });
  }
  private start(key: string, kind: ContainerResourceJob["kind"], work: (job: ContainerResourceJob, signal: AbortSignal) => Promise<void>): JobRun {
    if (this.closing || this.clearingCache) throw new Error("Resource manager is closing or clearing its cache; retry shortly");
    const prior = this.running.get(key);
    if (prior) return prior;
    const controller = new AbortController();
    const job: ContainerResourceJob = { id: randomUUID(), key, kind, state: "running", message: "", completedBytes: 0, totalBytes: 0, error: null, updatedAt: Date.now() };
    this.save(job);
    const promise = Promise.resolve().then(() => work(job, controller.signal)).then(() => { job.state = "complete"; }, error => {
      job.state = controller.signal.aborted ? "cancelled" : "error"; job.error = message(error); throw error;
    }).finally(() => { this.save(job); this.running.delete(key); });
    promise.catch(() => {});
    const run = { controller, promise, job }; this.running.set(key, run); return run;
  }
  private async downloadFiles(resources: ContainerResourceRevision[], job: ContainerResourceJob, signal: AbortSignal) {
    const files = this.resourceFiles(resources);
    job.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0, saved = 0;
    for (const file of files) {
      signal.throwIfAborted(); job.message = file.name;
      await this.files.ensure(file, this.url(file), signal, bytes => {
        job.completedBytes = completed + bytes;
        if (Date.now() - saved > 300) { this.save(job); saved = Date.now(); }
      });
      completed += file.size;
    }
    job.completedBytes = completed; this.save(job);
  }
  download(ids: string[]) {
    const resources = this.resolve(ids);
    return this.start(`download:${digest(resources.map(r => r.revision))}`, "download", (job, signal) => this.downloadFiles(resources, job, signal)).job;
  }
  cancel(id: string) {
    const run = [...this.running.values()].find(value => value.job.id === id);
    run?.controller.abort(new Error("Resource task cancelled"));
  }
  async prepare(engineName: ContainerEngine, resources: ContainerResourceRevision[], signal?: AbortSignal): Promise<string> {
    const key = `${engineName}:${digest([this.platform, resources.map(r => r.revision)])}`;
    let prepared = "";
    const run = this.start(key, "prepare", async (job, jobSignal) => {
      const engine = this.engines[engineName];
      const availability = await engine.probe();
      if (!availability.available) throw new Error(availability.error ?? "Container engine unavailable");
      const existing = this.store.sqlite.prepare("SELECT image_id FROM container_resource_images WHERE key=?").get(key) as { image_id: string } | undefined;
      if (existing) {
        try { await engine.run(["image", "inspect", existing.image_id]); prepared = existing.image_id; return; } catch { /* Recreate a removed image. */ }
      }
      await this.downloadFiles(resources, job, jobSignal);
      await this.serializePreparation(engineName, async () => {
        let parent = "";
        for (const resource of resources) {
          jobSignal.throwIfAborted();
          const stageKey = `${engineName}:${digest([this.platform, parent, resource.revision])}`;
          const saved = this.store.sqlite.prepare("SELECT image_id FROM container_resource_images WHERE key=?").get(stageKey) as { image_id: string } | undefined;
          if (saved) {
            try { await engine.run(["image", "inspect", saved.image_id]); parent = saved.image_id; continue; } catch { /* Recreate externally removed images from cache. */ }
          }
          job.message = resource.id; this.save(job);
          const variant = this.variant(resource);
          const tag = `localhost/llm-chat-resources:${digest(stageKey)}`;
          if (resource.id === "builtin:alpine") {
            const file = variant.files[0]!;
            await this.operation(engine, ["import", ...(engineName === "docker" ? ["--platform", this.platform] : ["--arch", this.platform.split("/")[1]!]), this.files.path(file.sha256), tag], jobSignal);
          } else {
            if (!parent) throw new Error("Resource lock has no base image");
            const name = `llm-chat-prepare-${this.owner}-${randomUUID()}`;
            const directory = join(this.root, `prepare-${randomUUID()}`);
            await mkdir(directory, { mode: 0o700 });
            try {
              for (const file of variant.files) await link(this.files.path(file.sha256), join(directory, file.name));
              await this.operation(engine, ["run", "--name", name, "--label", `fish.2kb.llm-chat.resource-owner=${this.owner}`, "--network", "none", "--user", "0:0", "--mount", mount(directory, "/resources"), "--entrypoint", "/bin/sh", parent, "-ec", `${variant.install}\n${variant.verify}`], jobSignal);
              await this.operation(engine, ["commit", "--change", "LABEL fish.2kb.llm-chat.runtime=2", name, tag], jobSignal);
            } finally {
              await engine.run(["rm", "-f", name]).catch(() => {});
              await rm(directory, { recursive: true, force: true });
            }
          }
          parent = JSON.parse(await engine.run(["image", "inspect", tag]))[0].Id as string;
          this.store.sqlite.prepare("INSERT OR REPLACE INTO container_resource_images VALUES (?,?,?)").run(stageKey, engineName, parent);
        }
        prepared = parent;
        this.store.sqlite.prepare("INSERT OR REPLACE INTO container_resource_images VALUES (?,?,?)").run(key, engineName, prepared);
      });
    });
    await waitForResource(run.promise, signal);
    return prepared || String(this.store.sqlite.prepare("SELECT image_id FROM container_resource_images WHERE key=?").get(key)?.image_id ?? "");
  }
  private async serializePreparation(engine: ContainerEngine, work: () => Promise<void>) {
    const previous = this.preparationQueues.get(engine) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.preparationQueues.set(engine, pending);
    try { await pending; } finally { if (this.preparationQueues.get(engine) === pending) this.preparationQueues.delete(engine); }
  }
  private async operation(engine: EngineAdapter, args: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const command = engine.command(args);
    await new Promise<void>((resolveOperation, reject) => {
      const child = spawn(command.executable, command.args, { stdio: ["ignore", "pipe", "pipe"] });
      let log = "", settled = false;
      const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-16384); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolveOperation();
      };
      const kill = (error: Error) => {
        child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); finish(error);
      };
      const abort = () => kill(new Error(message(signal.reason)));
      const timer = setTimeout(() => kill(new Error("Container resource preparation timed out")), 20 * 60_000);
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", finish);
      child.on("close", code => finish(code === 0 ? undefined : new Error(log || "Container resource installation failed")));
    });
  }
  async clearCache() {
    if (this.running.size || this.clearingCache) throw new Error("Finish or cancel resource tasks before clearing downloads");
    this.clearingCache = true;
    try {
      await this.files.close();
      await rm(this.files.directory, { recursive: true, force: true });
      // Clean up unfinished uploads left by v45 before offline imports were removed.
      await rm(join(this.root, "uploads"), { recursive: true, force: true });
      this.store.sqlite.prepare("DELETE FROM container_resource_uploads").run();
    } finally { this.clearingCache = false; }
    this.events.emit({ type: "resource-changed", resource: "container-resources" });
  }
  async close() {
    this.closing = true;
    const runs = [...this.running.values()]; runs.forEach(run => run.controller.abort(new Error("Resource manager is closing")));
    await Promise.allSettled(runs.map(run => run.promise));
    await this.files.close();
  }
}
