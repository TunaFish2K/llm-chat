import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalWorkspace, createDirectory, listDirectories } from "./workspaces";

describe("workspace directories", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llm-chat-workspaces-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("canonicalizes writable directories and rejects relative paths and files", async () => {
    const file = join(root, "file.txt");
    writeFileSync(file, "content");

    await expect(canonicalWorkspace(root)).resolves.toBe(realpathSync(root));
    await expect(canonicalWorkspace("relative/path")).rejects.toThrow("工作目录必须是绝对路径");
    await expect(canonicalWorkspace(file)).rejects.toThrow("工作目录不是目录");
  });

  it("lists only directories with stable ordering and hidden metadata", async () => {
    mkdirSync(join(root, "zeta"));
    mkdirSync(join(root, ".hidden"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "ignored.txt"), "content");

    const result = await listDirectories(root);

    expect(result.path).toBe(realpathSync(root));
    expect(result.parentPath).toBe(parse(root).dir);
    expect(result.entries).toEqual([
      { name: ".hidden", path: join(realpathSync(root), ".hidden"), directory: true, hidden: true },
      { name: "alpha", path: join(realpathSync(root), "alpha"), directory: true, hidden: false },
      { name: "zeta", path: join(realpathSync(root), "zeta"), directory: true, hidden: false }
    ]);
    await expect(listDirectories("relative/path")).rejects.toThrow("目录路径必须是绝对路径");
  });

  it("reports no parent for the filesystem root", async () => {
    const filesystemRoot = parse(realpathSync(root)).root;
    const result = await listDirectories(filesystemRoot);
    expect(result.parentPath).toBeNull();
  });

  it("creates a private child directory and rejects invalid targets", async () => {
    const created = await createDirectory(join(root, "new-project"));

    expect(created).toBe(realpathSync(join(root, "new-project")));
    await expect(canonicalWorkspace(created)).resolves.toBe(created);
    await expect(createDirectory("relative/path")).rejects.toThrow("目录路径必须是绝对路径");
    await expect(createDirectory(`${root}/.`)).rejects.toThrow("新目录名称无效");
    await expect(createDirectory(join(root, "new-project"))).rejects.toThrow();
  });
});
