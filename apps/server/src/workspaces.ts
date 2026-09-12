import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import type { DirectoryListingDto } from "@llm-chat/contracts";

export async function canonicalWorkspace(path: string): Promise<string> {
  validateDirectoryPath(path, "工作目录必须是绝对路径");
  return directoryOperation(async () => {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("工作目录不是目录");
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
    return canonical;
  }, "工作目录需要读取、写入和访问权限");
}

export async function listDirectories(path: string): Promise<DirectoryListingDto> {
  return directoryOperation(async () => {
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
  });
}

export async function createDirectory(path: string): Promise<string> {
  validateDirectoryPath(path);
  return directoryOperation(async () => {
    const parent = await canonicalReadableDirectory(dirname(path));
    const name = basename(path);
    if (!name || name === "." || name === "..") throw new Error("新目录名称无效");
    const target = resolve(parent, name);
    await mkdir(target, { mode: 0o700 });
    return canonicalWorkspace(target);
  }, "没有权限在此目录中新建目录");
}

async function canonicalReadableDirectory(path: string): Promise<string> {
  validateDirectoryPath(path);
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("路径不是目录");
  await access(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}

function validateDirectoryPath(path: string, relativeMessage = "目录路径必须是绝对路径"): void {
  if (!path.trim()) throw new Error("请输入目录路径");
  if (path.includes("\0")) throw new Error("目录路径包含非法字符");
  if (path.length > 4096) throw new Error("目录路径过长");
  if (!isAbsolute(path)) throw new Error(relativeMessage);
}

async function directoryOperation<T>(operation: () => Promise<T>, permissionMessage = "没有权限读取或访问此目录"): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    const messages: Record<string, string> = {
      ENOENT: "目录不存在，请检查路径",
      ENOTDIR: "路径不是目录，请选择文件夹",
      EACCES: permissionMessage,
      EPERM: permissionMessage,
      EROFS: "此目录位于只读文件系统，无法写入",
      ENAMETOOLONG: "目录路径过长",
      ELOOP: "路径中的符号链接存在循环或层数过多",
      EINVAL: "目录路径无效",
      EEXIST: "该名称已存在，请使用其他目录名称"
    };
    if (code) throw new Error(messages[code] ?? "无法访问目录，请稍后重试", { cause });
    throw cause;
  }
}
