import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalWorkspace, createDirectory, listDirectories } from "./workspaces";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access), mkdir: vi.fn(actual.mkdir) };
});

describe("workspace directories", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llm-chat-workspaces-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("preserves spaces and Chinese names and resolves symbolic links", async () => {
    const target = join(root, "中文 project ");
    const link = join(root, "shortcut");
    mkdirSync(target);
    symlinkSync(target, link);
    for (const path of [target, link, `${target}/../中文 project /`]) {
      expect((await listDirectories(path)).path).toBe(realpathSync(target));
      await expect(canonicalWorkspace(path)).resolves.toBe(realpathSync(target));
    }
  });

  it("explains invalid, missing, non-directory, long and cyclic paths", async () => {
    const file = join(root, "file.txt");
    writeFileSync(file, "content");
    const loop = join(root, "loop");
    symlinkSync(loop, loop);
    for (const [path, message] of [
      ["", "请输入目录路径"],
      ["   ", "请输入目录路径"],
      ["~/project", "必须是绝对路径"],
      ["relative/path", "必须是绝对路径"],
      [`${root}/bad\0path`, "包含非法字符"],
      [join(root, "missing"), "目录不存在"],
      [file, "不是目录"],
      [join(file, "child"), "不是目录"],
      [`${root}/${"a".repeat(300)}`, "目录路径过长"],
      [`/${"a".repeat(4096)}`, "目录路径过长"],
      [loop, "符号链接存在循环"]
    ]) {
      await expect(listDirectories(path!)).rejects.toThrow(message);
      await expect(canonicalWorkspace(path!)).rejects.toThrow(message);
    }
  });

  it("distinguishes browsing permissions from workspace write permissions", async () => {
    const denied = Object.assign(new Error("raw OS error"), { code: "EACCES" });
    const access = vi.mocked(fs.access);
    access.mockRejectedValueOnce(denied);
    await expect(listDirectories(root)).rejects.toThrow("没有权限读取或访问此目录");
    await expect(listDirectories(root)).resolves.toMatchObject({ path: realpathSync(root) });
    access.mockRejectedValueOnce(denied);
    await expect(canonicalWorkspace(root)).rejects.toThrow("工作目录需要读取、写入和访问权限");
    vi.mocked(fs.mkdir).mockRejectedValueOnce(denied);
    await expect(createDirectory(join(root, "denied"))).rejects.toThrow("没有权限在此目录中新建目录");
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
