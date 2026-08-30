import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import type { DirectoryListingDto } from "@llm-chat/contracts";

export async function canonicalWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("工作目录必须是绝对路径");
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("工作目录不是目录");
  await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
  return canonical;
}

export async function listDirectories(path: string): Promise<DirectoryListingDto> {
  const canonical = await canonicalReadableDirectory(path);
  const root = parse(canonical).root;
  const entries = await readdir(canonical, { withFileTypes: true });
  return {
    path: canonical,
    parentPath: canonical === root ? null : dirname(canonical),
    entries: entries.filter((entry) => entry.isDirectory()).map((entry) => ({
      name: entry.name,
      path: resolve(canonical, entry.name),
      directory: true,
      hidden: entry.name.startsWith(".")
    })).sort((left, right) => left.name.localeCompare(right.name))
  };
}

export async function createDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("目录路径必须是绝对路径");
  const parent = await canonicalReadableDirectory(dirname(path));
  const name = basename(path);
  if (!name || name === "." || name === "..") throw new Error("新目录名称无效");
  const target = resolve(parent, name);
  await mkdir(target, { mode: 0o700 });
  return canonicalWorkspace(target);
}

async function canonicalReadableDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("目录路径必须是绝对路径");
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("路径不是目录");
  await access(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}
