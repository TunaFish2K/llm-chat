import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "./events";
import { SkillManager } from "./skills";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => cleanupStores());

describe("SkillManager", () => {
  it("discovers only direct Agent Skills children and keeps changed revisions pending", async () => {
    const store = createStore();
    const root = resolve(store.dataDir, "agent-skills");
    const source = resolve(root, "review-helper");
    mkdirSync(source, { recursive: true });
    writeFileSync(resolve(source, "SKILL.md"), [
      "---",
      "name: review-helper",
      "description: >-",
      "  Review code with a real YAML parser.",
      "compatibility: Requires git",
      "allowed-tools: workspace_shell",
      "requiredTools:",
      "  - workspace_read_file",
      "  - workspace_grep",
      "recommendedApprovals:",
      "  workspace_read_file: never",
      "---",
      "# Review helper"
    ].join("\n"));
    const nested = resolve(root, "container", "nested-skill");
    mkdirSync(nested, { recursive: true });
    writeFileSync(resolve(nested, "SKILL.md"), "---\nname: nested-skill\ndescription: Nested\n---\n");
    const invalid = resolve(root, "wrong-directory");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(resolve(invalid, "SKILL.md"), "---\nname: other-name\ndescription: Wrong\n---\n");
    const manager = new SkillManager(store, new EventHub(), { discoveryRoot: root });

    const first = await manager.discover();
    expect(first).toMatchObject({ discovered: 1, updated: 0, unchanged: 0, unloaded: 0 });
    expect(first.errors).toEqual([expect.objectContaining({ path: resolve(invalid, "SKILL.md"), message: expect.stringContaining("match") })]);
    const discovered = manager.list().find((skill) => skill.id === "agents.review-helper")!;
    expect(discovered).toMatchObject({
      name: "review-helper", description: "Review code with a real YAML parser.", compatibility: "Requires git",
      sourceKind: "agents", bundled: false, state: "loaded",
      requiredTools: ["workspace_read_file", "workspace_grep"],
      recommendedApprovals: { workspace_read_file: "never" }
    });
    expect(discovered.requiredTools).not.toContain("workspace_shell");
    expect(manager.list().some((skill) => skill.id === "agents.nested-skill")).toBe(false);

    writeFileSync(resolve(source, "SKILL.md"), [
      "---", "name: review-helper", "description: Updated", "requiredTools: [workspace_read_file]", "---", "Updated"
    ].join("\n"));
    const changed = await manager.discover();
    expect(changed.updated).toBe(1);
    expect(manager.list().find((skill) => skill.id === discovered.id)).toMatchObject({
      revision: discovered.revision, state: "pending-reload", description: discovered.description
    });
    expect((await manager.discover()).unchanged).toBe(1);
    const reloaded = await manager.reload(discovered.id);
    expect(reloaded).toMatchObject({ state: "loaded", description: "Updated", sourceKind: "agents" });
    expect(reloaded.revision).not.toBe(discovered.revision);

    rmSync(source, { recursive: true, force: true });
    expect(await manager.discover()).toMatchObject({ unloaded: 1 });
    expect(manager.list().find((skill) => skill.id === discovered.id)?.state).toBe("unloaded");
    expect(manager.activeRevisions([discovered.id])).toEqual({});
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM skill_revisions WHERE skill_id = ?")
      .get(discovered.id)).toMatchObject({ count: 2 });
    manager.close();
  });

  it("initializes bundled and legacy Skills idempotently", async () => {
    const store = createStore();
    const legacy = resolve(store.dataDir, "skills", "legacy-helper");
    mkdirSync(legacy, { recursive: true });
    writeSkill(legacy, "legacy-helper", "Legacy Helper");
    mkdirSync(resolve(store.dataDir, "skills", "broken-helper"));
    writeFileSync(resolve(store.dataDir, "skills", "not-a-directory"), "ignored");
    const events = new EventHub();
    const emitted: string[] = [];
    events.subscribe(0, (event) => { if (event.type === "skill") emitted.push(event.skillId); });
    const manager = new SkillManager(store, events);

    await manager.initialize();
    await manager.initialize();

    expect(manager.list().map((item) => item.id)).toEqual(expect.arrayContaining([
      "coding-supervisor", "tool-author", "legacy-helper"
    ]));
    expect(manager.list().filter((item) => item.bundled)).toHaveLength(2);
    expect(emitted).toEqual(expect.arrayContaining(["coding-supervisor", "tool-author", "legacy-helper"]));
    manager.close();
  });

  it("installs, reloads, pins, reads, and removes a Skill safely", async () => {
    const store = createStore();
    const events = new EventHub();
    const manager = new SkillManager(store, events);
    const source = resolve(store.dataDir, "source-skill");
    mkdirSync(resolve(source, "references"), { recursive: true });
    writeFileSync(resolve(source, ".git"), "ignored by the revision hash");
    writeSkill(source, "Docs Helper", "Docs Helper", [
      "requiredTools: web_search, workspace_read_file",
      "recommendedApprovals: workspace_read_file=always, web_search=never, bad=invalid"
    ]);
    writeFileSync(resolve(source, "references", "guide.md"), "reference text");
    await expect(manager.install(resolve(source, "SKILL.md"))).rejects.toThrow("Skill source must be a directory");

    const installed = await manager.install(source);
    expect(installed).toMatchObject({
      id: "docs-helper", name: "Docs Helper", state: "loaded", bundled: false,
      requiredTools: ["web_search", "workspace_read_file"],
      recommendedApprovals: { workspace_read_file: "always", web_search: "never" }
    });
    expect(manager.activeRevisions(["docs-helper", "missing"])).toEqual({ "docs-helper": installed.revision });
    expect(manager.activeRevisions([])).toEqual({});

    const unpinned = manager.tool();
    expect(unpinned.available).toBe(true);
    expect(await unpinned.requiresApproval({})).toBe(false);
    await expect(unpinned.execute({ id: "docs-helper" }, signal())).resolves.toContain("# Docs Helper");
    await expect(unpinned.execute({ name: "docs-helper", path: "references/guide.md" }, signal())).resolves.toBe("reference text");
    await expect(unpinned.execute({ id: "missing" }, signal())).rejects.toThrow("not enabled");
    await expect(unpinned.execute({ id: "docs-helper", path: "../outside" }, signal())).rejects.toThrow("escapes");
    const revisionRow = store.sqlite.prepare("SELECT path FROM skill_revisions WHERE skill_id = ? AND revision = ?")
      .get("docs-helper", installed.revision) as { path: string };
    const outside = resolve(store.dataDir, "outside-reference.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, resolve(revisionRow.path, "external.md"));
    await expect(unpinned.execute({ id: "docs-helper", path: "external.md" }, signal())).rejects.toThrow("outside its revision");

    const record = generation(store);
    record.agentSnapshot.skillRevisions = { "docs-helper": installed.revision };
    const pinned = manager.tool(record);
    expect(pinned.definition.description).toContain("docs-helper");
    await expect(pinned.execute({ id: "docs-helper" }, signal())).resolves.toContain("# Docs Helper");
    await expect(pinned.execute({ id: "other" }, signal())).rejects.toThrow("not enabled");
    record.agentSnapshot.skillRevisions = {};
    expect(manager.tool(record).available).toBe(false);
    record.agentSnapshot.skillRevisions = { "docs-helper": "missing-revision" };
    await expect(manager.tool(record).execute({ id: "docs-helper" }, signal())).rejects.toThrow("Skill revision not found");
    record.agentSnapshot.skillRevisions = { "docs-helper": installed.revision };

    writeFileSync(resolve(source, "SKILL.md"), `${await unpinned.execute({ id: "docs-helper" }, signal())}\nChanged`);
    await until(() => manager.list()[0]?.state === "pending-reload");
    expect(manager.activeRevisions(["docs-helper"])).toEqual({ "docs-helper": installed.revision });

    const reloaded = await manager.reload("docs-helper");
    expect(reloaded.revision).not.toBe(installed.revision);
    expect(await pinned.activatesTools?.({ id: "docs-helper" })).toEqual(["web_search", "workspace_read_file"]);
    await expect(manager.reload("missing")).rejects.toThrow("Skill not found");

    store.sqlite.prepare("UPDATE generations SET agent_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(record.agentSnapshot), record.id);
    await expect(manager.remove("docs-helper")).rejects.toThrow("active generation");
    store.sqlite.prepare("UPDATE generations SET agent_snapshot_json = '{' WHERE id = ?").run(record.id);
    await manager.remove("docs-helper");
    expect(manager.list()).toEqual([]);
    await expect(manager.remove("docs-helper")).rejects.toThrow("Skill not found");
    manager.close();
  });

  it("protects bundled Skills and tolerates malformed stored metadata", async () => {
    const store = createStore();
    const manager = new SkillManager(store, new EventHub());
    const source = resolve(store.dataDir, "bundled-source");
    mkdirSync(source);
    writeSkill(source, "bundled", "Bundled");
    const bundled = await manager.install(source, true);
    await expect(manager.remove(bundled.id)).rejects.toThrow("Bundled skills cannot be removed");

    store.sqlite.prepare("UPDATE skill_installations SET required_tools_json = '{}', recommended_approvals_json = 'bad' WHERE id = ?").run(bundled.id);
    expect(manager.list()[0]).toMatchObject({ requiredTools: [], recommendedApprovals: {} });
    store.sqlite.prepare("UPDATE skill_installations SET required_tools_json = 'bad' WHERE id = ?").run(bundled.id);
    expect(manager.list()[0]).toMatchObject({ requiredTools: [], recommendedApprovals: {} });
    const outside = resolve(store.dataDir, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, resolve(source, "link"));
    await expect(manager.install(source, true)).rejects.toThrow("symbolic links");
    manager.close();
  });

  it("rolls an existing Skill into error state when activation fails", async () => {
    const store = createStore();
    const events = new EventHub();
    const manager = new SkillManager(store, events);
    const source = resolve(store.dataDir, "error-source");
    mkdirSync(source);
    writeSkill(source, "failure", "Failure");
    await manager.install(source);

    const emit = vi.spyOn(events, "emit");
    emit.mockImplementationOnce(() => { throw "activation failed"; });
    await expect(manager.install(source)).rejects.toBe("activation failed");
    expect(manager.list()[0]).toMatchObject({ state: "error", error: "activation failed" });
    emit.mockRestore();
    await manager.install(source);

    const error = new Error("activation exception");
    const emitError = vi.spyOn(events, "emit");
    emitError.mockImplementationOnce(() => { throw error; });
    await expect(manager.install(source)).rejects.toBe(error);
    expect(manager.list()[0]).toMatchObject({ state: "error", error: "activation exception" });
    emitError.mockRestore();
    manager.close();
  });

  it("uses safe metadata fallbacks and normalizes punctuation in ids", async () => {
    const store = createStore();
    const manager = new SkillManager(store, new EventHub());
    const plain = resolve(store.dataDir, "Plain Skill");
    mkdirSync(plain);
    writeFileSync(resolve(plain, "SKILL.md"), "# Plain instructions");
    expect(await manager.install(plain)).toMatchObject({
      id: "plain-skill", name: "plain-skill", description: "", requiredTools: [], recommendedApprovals: {}
    });

    const invalid = resolve(store.dataDir, "invalid");
    mkdirSync(invalid);
    writeSkill(invalid, "!!!", "Invalid");
    expect(await manager.install(invalid)).toMatchObject({ id: "---", name: "Invalid" });
    manager.close();
  });

  it("ignores excluded source changes and suppresses pending reload after close", async () => {
    const store = createStore();
    const manager = new SkillManager(store, new EventHub());
    const source = resolve(store.dataDir, "watched-source");
    mkdirSync(source);
    writeSkill(source, "watched", "Watched");
    await manager.install(source);
    mkdirSync(resolve(source, "node_modules"));
    writeFileSync(resolve(source, "node_modules", "ignored"), "change");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(manager.list()[0]?.state).toBe("loaded");

    (manager as unknown as { closed: boolean }).closed = true;
    writeFileSync(resolve(source, "SKILL.md"), `${String(Date.now())}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    expect(manager.list()[0]?.state).toBe("loaded");
    manager.close();
  });
});

function writeSkill(path: string, id: string, name: string, fields: string[] = []): void {
  writeFileSync(resolve(path, "SKILL.md"), [
    "---", `id: ${id}`, `name: ${name}`, "description: Test skill", ...fields, "---", `# ${name}`, "Instructions"
  ].join("\n"));
}

function signal(): AbortSignal { return new AbortController().signal; }

function generation(store: ReturnType<typeof createStore>) {
  seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const created = store.createMessageGeneration(conversation.id, "test");
  return store.getGenerationRecord(created.generationId)!;
}

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("condition timed out");
}
