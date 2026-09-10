import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, readlink, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { executeProcess, ShellError } from "./shell";

const SCRATCH_BYTES = 64 * 1024 * 1024;
const RUNTIME_PATHS = ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/share", "/bin", "/sbin", "/lib", "/lib64"];

export interface ReadonlyShellInput {
  command: string;
  project: string | null;
  attachments: string | null;
  workspace: "project" | "attachments";
  cwd: string;
  timeout: number;
}

/** Linux seccomp BPF: reject foreign ABIs, socket creation and io_uring bypasses.
 * Socket pairs and pipes within the isolated process tree remain usable.
 * Syscall numbers are from Linux UAPI for x86-64 and AArch64.
 */
function socketFilter(): Buffer {
  const architecture = process.arch === "x64" ? 0xc000003e : process.arch === "arm64" ? 0xc00000b7 : null;
  if (architecture === null) throw new Error("只读 Shell 暂不支持此 CPU 架构");
  const instructions: number[][] = [
    [0x20, 0, 0, 4], [0x15, 1, 0, architecture], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001],
    [0x15, 0, 1, process.arch === "x64" ? 41 : 198], [0x06, 0, 0, 0x00050001],
    [0x15, 0, 1, 425], [0x06, 0, 0, 0x00050001], [0x06, 0, 0, 0x7fff0000]
  ];
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, value], index) => {
    buffer.writeUInt16LE(code!, index * 8);
    buffer[index * 8 + 2] = jt!;
    buffer[index * 8 + 3] = jf!;
    buffer.writeUInt32LE(value!, index * 8 + 4);
  });
  return buffer;
}

function inside(root: string, path: string): string {
  const suffix = relative(root, path);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new Error("工作目录超出所选工作区");
  return suffix;
}

async function systemMounts(): Promise<string[]> {
  // Node may be installed by nvm or CI outside /usr; expose only its executable.
  const args: string[] = ["--ro-bind", await realpath(process.execPath), "/runtime/node"];
  for (const path of RUNTIME_PATHS) {
    const entry = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) continue;
    args.push(...entry.isSymbolicLink() ? ["--symlink", await readlink(path), path] : ["--ro-bind", path, path]);
  }
  for (const path of ["/etc/ld.so.cache", "/etc/localtime"]) {
    try { args.push("--ro-bind", await realpath(path), path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return args;
}

/** Never follow symlinks when examining a mounted tree. Replace special files
 * with empty read-only regular files, including FIFOs (ro-bind alone permits IPC).
 */
async function maskSpecialFiles(root: string, destination: string, signal: AbortSignal): Promise<string[]> {
  const pending = [""];
  const masks: string[] = [];
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile() && !entry.isSymbolicLink()) {
        if (masks.length >= 3000) throw new Error("工作目录包含过多特殊文件，无法建立只读沙箱");
        masks.push("--ro-bind", "/proc/self/fd/4", join(destination, path));
      }
    }
  }
  return masks;
}

export class ReadonlyShellManager {
  private binary: string | null = null;
  private mounts: string[] = [];
  private ready: Promise<void> | undefined;
  private closing = false;
  private readonly active = new Map<AbortController, Promise<string>>();
  private failure: string | null = "只读 Shell 尚未初始化";

  get available(): boolean { return this.binary !== null && this.failure === null && !this.closing; }
  get error(): string | null { return this.closing ? "只读 Shell 已关闭" : this.failure; }

  initialize(): Promise<void> {
    this.ready ??= this.probe();
    return this.ready;
  }

  private async probe(): Promise<void> {
    try {
      if (process.platform !== "linux") throw new Error("只读 Shell 目前仅支持 Linux");
      socketFilter();
      // Resolve the executable once; workspace PATH changes cannot replace it.
      for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
        if (!isAbsolute(directory)) continue;
        const candidate = join(directory, "bwrap");
        try { await access(candidate, constants.X_OK); this.binary = await realpath(candidate); break; }
        catch { /* Try the next configured system program directory. */ }
      }
      if (!this.binary) throw new Error("未找到 Bubblewrap，请安装 bubblewrap 并重启服务");
      const versionResult = JSON.parse(await executeProcess(this.binary, ["--version"], "/", 2000, new AbortController().signal, { env: {} }));
      const version = /bubblewrap\s+(\d+)\.(\d+)\.(\d+)/.exec(versionResult.stdout);
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 12)) {
        throw new Error("需要 Bubblewrap 0.12.0 或更高版本，请升级后重启服务");
      }
      this.mounts = await systemMounts();
      await this.launch({ command: "test ! -w /usr && test ! -w / && test -w /tmp && test ! -e /home && test ! -e /run",
        project: null, attachments: null, workspace: "project", cwd: ".", timeout: 5000 }, new AbortController().signal, true);
      this.failure = null;
    } catch (error) {
      const detail = error instanceof ShellError ? error.result.stderr.trim() || error.message : String(error instanceof Error ? error.message : error);
      this.failure = `只读 Shell 不可用：${detail}`;
    }
  }

  execute(input: ReadonlyShellInput, signal: AbortSignal): Promise<string> {
    if (!this.available) return Promise.reject(new Error(this.error ?? "只读 Shell 不可用"));
    const controller = new AbortController();
    const work = this.launch(input, AbortSignal.any([signal, controller.signal]));
    this.active.set(controller, work);
    void work.finally(() => this.active.delete(controller)).catch(() => {});
    return work;
  }

  private async launch(input: ReadonlyShellInput, callerSignal: AbortSignal, probe = false): Promise<string> {
    const deadline = AbortSignal.timeout(input.timeout);
    const signal = AbortSignal.any([callerSignal, deadline]);
    const started = Date.now();
    const handles: FileHandle[] = [];
    let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      temporary = await mkdtemp(join(tmpdir(), "llm-chat-readonly-"));
      const policyPath = join(temporary, "socket-filter");
      const emptyPath = join(temporary, "empty");
      await writeFile(policyPath, socketFilter(), { mode: 0o600 });
      await writeFile(emptyPath, "", { mode: 0o600 });
      handles.push(await open(policyPath, "r"));
      handles.push(await open(emptyPath, "r"));
      const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
        "--die-with-parent", "--new-session", "--cap-drop", "ALL", ...this.mounts,
        "--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev", "--remount-ro", "/dev",
        "--size", String(SCRATCH_BYTES), "--tmpfs", "/tmp", "--dir", "/tmp/home",
        "--seccomp", "3", "--clearenv", "--setenv", "PATH", "/runtime:/usr/bin:/bin",
        "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "GIT_OPTIONAL_LOCKS", "0", "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
        "--setenv", "PYTHONDONTWRITEBYTECODE", "1"];
      let cwd = "/tmp";
      for (const [kind, requested, destination] of [
        ["project", input.project, "/workspace"], ["attachments", input.attachments, "/attachments"]
      ] as const) {
        if (!requested) continue;
        const root = await realpath(requested);
        // Pin each directory for mount setup, even if its host path is replaced.
        const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(handle);
        // The fd form verifies mount identity and closes the setup descriptor.
        args.push("--ro-bind-fd", String(handles.length + 2), destination);
        args.push(...await maskSpecialFiles(`/proc/self/fd/${handle.fd}`, destination, signal));
        if (kind === input.workspace) {
          const target = input.cwd === "/workspace" ? "." : input.cwd.replace(/^\/workspace\//, "");
          if (isAbsolute(target)) throw new Error("cwd 必须是工作区相对路径");
          const resolved = await realpath(resolve(root, target));
          cwd = join(destination, inside(root, resolved));
        }
      }
      if (!probe && !(input.workspace === "attachments" ? input.attachments : input.project)) {
        throw new Error(input.workspace === "attachments" ? "当前会话没有附件工作区" : "当前会话没有项目工作目录");
      }
      signal.throwIfAborted();
      // Consume the shared mask source too; no host directory/file descriptors
      // may survive setup in either the payload or the sandbox's init process.
      args.push("--ro-bind-fd", "4", "/runtime/empty", "--chdir", cwd, "--remount-ro", "/", "--", "/bin/sh", "-c", input.command);
      return await executeProcess(this.binary!, args, "/", Math.max(1, input.timeout - (Date.now() - started)), signal,
        { env: {}, fds: handles.map((handle) => handle.fd) });
    } catch (error) {
      if (deadline.aborted && !callerSignal.aborted) {
        throw new ShellError({ exitCode: null, signal: null, stdout: "", stderr: "", truncated: false,
          ...(error instanceof ShellError ? error.result : {}), timedOut: true, cancelled: false }, "命令执行超时");
      }
      throw error;
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.ready;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
