import { withMessage, translate, type MessageKey } from "@llm-chat/i18n";
import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import type { DirectoryListingDto } from "@llm-chat/contracts";

export async function canonicalWorkspace(path: string): Promise<string> {
  validateDirectoryPath(path, "directory.workspace_absolute");
  return directoryOperation(async () => {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw withMessage(new Error("工作目录不是目录"), "error.the_working_path_is_not_a_directory");
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
    return canonical;
  }, "directory.workspace_permission");
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
    if (!name || name === "." || name === "..") throw withMessage(new Error("新目录名称无效"), "error.invalid_new_directory_name");
    const target = resolve(parent, name);
    await mkdir(target, { mode: 0o700 });
    return canonicalWorkspace(target);
  }, "directory.create_permission");
}

async function canonicalReadableDirectory(path: string): Promise<string> {
  validateDirectoryPath(path);
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw withMessage(new Error("路径不是目录"), "error.the_path_is_not_a_directory");
  await access(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}

function validateDirectoryPath(path: string, relativeMessage: MessageKey = "directory.absolute"): void {
  if (!path.trim()) throw withMessage(new Error("请输入目录路径"), "error.enter_a_directory_path");
  if (path.includes("\0")) throw withMessage(new Error("目录路径包含非法字符"), "error.the_directory_path_contains_invalid_characters");
  if (path.length > 4096) throw withMessage(new Error("目录路径过长"), "error.the_directory_path_is_too_long");
  if (!isAbsolute(path)) throw directoryError(relativeMessage);
}

async function directoryOperation<T>(operation: () => Promise<T>, permissionMessage: MessageKey = "directory.read_permission"): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    const messages: Record<string, MessageKey> = {
      ENOENT: "directory.not_found",
      ENOTDIR: "directory.not_directory",
      EACCES: permissionMessage,
      EPERM: permissionMessage,
      EROFS: "directory.read_only",
      ENAMETOOLONG: "directory.too_long",
      ELOOP: "directory.symlink_loop",
      EINVAL: "directory.invalid",
      EEXIST: "directory.exists"
    };
    if (code) throw directoryError(messages[code] ?? "directory.unavailable", cause);
    throw cause;
  }
}

function directoryError(key: MessageKey, cause?: unknown): Error { return withMessage(new Error(translate("zh-CN", key), { cause }), key); }
