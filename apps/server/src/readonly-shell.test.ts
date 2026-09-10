import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, readSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadonlyShellManager, type ReadonlyShellInput } from "./readonly-shell";
import { ShellError } from "./shell";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("reports a missing runtime and never falls back to an ordinary shell", async () => {
  vi.stubEnv("PATH", "");
  const manager = new ReadonlyShellManager();
  try {
    await manager.initialize();
    expect(manager.available).toBe(false);
    expect(manager.error).toMatch(/Bubblewrap|Linux/);
    await expect(manager.execute({ command: "printf should-not-run", project: "/tmp", attachments: null,
      workspace: "project", cwd: ".", timeout: 1000 }, new AbortController().signal)).rejects.toThrow(/不可用/);
  } finally { await manager.close(); vi.unstubAllEnvs(); }
});

// Real Linux isolation is a required test dependency, not a mocked success path.
describe.skipIf(process.platform !== "linux")("real read-only sandbox", () => {
  let manager: ReadonlyShellManager;
  let directory: string;
  let project: string;
  let attachments: string;
  const run = (command: string, options: Partial<ReadonlyShellInput> = {}, signal = new AbortController().signal) =>
    manager.execute({ command, project, attachments, workspace: "project", cwd: ".", timeout: 5000, ...options }, signal)
      .then((output) => JSON.parse(output));

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "llm-chat-readonly-test-"));
    project = join(directory, "project");
    attachments = join(directory, "attachments");
    await mkdir(project); await mkdir(attachments);
    await writeFile(join(project, "sample.txt"), "beta\nalpha\nbeta\n");
    await writeFile(join(attachments, "attached.txt"), "attachment");
    manager = new ReadonlyShellManager();
    await manager.initialize();
    expect(manager.error, "Install Bubblewrap and enable unprivileged user namespaces for this test").toBeNull();
    expect(manager.available).toBe(true);
  });
  afterEach(async () => { await manager?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it("runs loops, pipelines, analysis scripts, relative cwd and attachment-only calls", async () => {
    expect((await run("for f in sample.txt; do cat \"$f\"; done | sort -u")).stdout).toBe("alpha\nbeta\n");
    expect((await run(`node -e ${quote("const fs=require('node:fs'); console.log(fs.readFileSync('sample.txt','utf8').trim().split('\\n').length)")}`)).stdout).toBe("3\n");
    expect((await run("python3 -c 'print(6 * 7)'")).stdout).toBe("42\n");
    expect((await run("cat /workspace/sample.txt /attachments/attached.txt")).stdout).toContain("attachment");
    await mkdir(join(project, "sub"));
    expect((await run("pwd; cat ../sample.txt", { cwd: "sub" })).stdout).toContain("/workspace/sub\n");
    expect((await run("cat attached.txt", { project: null, workspace: "attachments" })).stdout).toBe("attachment");
    expect((await run("pwd", { cwd: "/workspace" })).stdout).toBe("/workspace\n");
  });

  it.each([
    "printf changed > sample.txt", "printf changed >> sample.txt", "touch new.txt", "mkdir created",
    "rm sample.txt", "mv sample.txt moved.txt", "chmod 777 sample.txt", "ln sample.txt linked.txt",
    "printf changed > /attachments/attached.txt"
  ])("blocks host mutation: %s", async (command) => {
    await chmod(join(project, "sample.txt"), 0o640);
    await expect(run(command)).rejects.toBeInstanceOf(ShellError);
    expect(await readFile(join(project, "sample.txt"), "utf8")).toBe("beta\nalpha\nbeta\n");
    expect((await stat(join(project, "sample.txt"))).mode & 0o777).toBe(0o640);
    expect(await readFile(join(attachments, "attached.txt"), "utf8")).toBe("attachment");
  });

  it("keeps scratch private, bounded and disposable and does not inherit host environment", async () => {
    vi.stubEnv("LLM_CHAT_READONLY_SECRET", "must-not-appear");
    try {
      const script = "const fs=require('node:fs'); console.log(JSON.stringify({home:process.env.HOME,secret:process.env.LLM_CHAT_READONLY_SECRET??null,bytes:fs.statfsSync('/tmp').blocks*fs.statfsSync('/tmp').bsize}))";
      const result = JSON.parse((await run(`node -e ${quote(script)}`)).stdout);
      expect(result).toEqual({ home: "/tmp/home", secret: null, bytes: 64 * 1024 * 1024 });
      expect((await run("printf intermediate > /tmp/result; cat /tmp/result")).stdout).toBe("intermediate");
      expect((await run("test ! -e /tmp/result; test ! -w /dev/shm; test ! -w /")).exitCode).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("hides other host files, outside symlinks and other conversations and validates cwd", async () => {
    const outside = join(directory, "other-conversation.txt");
    await writeFile(outside, "not-authorized");
    await symlink(outside, join(project, "outside-link"));
    await symlink(directory, join(project, "outside-dir"));
    await symlink("sample.txt", join(project, "inside-link"));
    expect((await run("cat inside-link")).stdout).toContain("alpha");
    for (const path of [outside, "outside-link", "/home", "/run", "/proc/1/root" + outside]) {
      await expect(run(`cat ${quote(path)}`)).rejects.toBeInstanceOf(ShellError);
    }
    for (const cwd of ["..", "outside-dir", "/etc", "missing"]) await expect(run("pwd", { cwd })).rejects.toThrow();
    const descriptorPaths = (await run(`node -e ${quote("const fs=require('node:fs'); for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))) { try { for(const fd of fs.readdirSync('/proc/'+pid+'/fd')) { try { console.log(fs.readlinkSync('/proc/'+pid+'/fd/'+fd)) } catch {} } } catch {} }")}`)).stdout;
    expect(descriptorPaths).not.toContain(directory);
    expect(descriptorPaths).not.toContain("socket-filter");
    await expect(run("pwd", { project: null })).rejects.toThrow("没有项目");
    await expect(run("pwd", { attachments: null, workspace: "attachments" })).rejects.toThrow("没有附件");
  });

  it("blocks network sockets and masks host Unix sockets and FIFOs as read-only files", async () => {
    const socket = join(project, "host.sock");
    const server = createServer(() => { throw new Error("Sandbox reached host IPC"); });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const fifo = join(project, "host.fifo");
    execFileSync("mkfifo", [fifo]);
    const fifoReader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const masked = await run("test -f host.sock && test -f host.fifo && test ! -w host.sock && test ! -w host.fifo").catch((error) => error.result);
      expect(masked).toMatchObject({ exitCode: 0, stderr: "" });
      await expect(run("printf forbidden > host.fifo")).rejects.toBeInstanceOf(ShellError);
      expect(readSync(fifoReader, Buffer.alloc(32), 0, 32, null)).toBe(0);
      for (const address of ["127.0.0.1", "1.1.1.1", "/workspace/host.sock"]) {
        const script = `const net=require('node:net'); const c=net.connect(${address.startsWith("/") ? quote(address) : `{host:${quote(address)},port:80}`}); c.on('error',e=>{console.log(e.code);process.exit(0)});c.on('connect',()=>process.exit(9));`;
        expect((await run(`node -e ${quote(script)}`)).stdout).toMatch(/EPERM|EACCES/);
      }
    } finally { closeSync(fifoReader); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("preserves error output and bounds successful output", async () => {
    const error = await run("printf partial; printf reason >&2; exit 7").catch((error) => error);
    expect(error).toMatchObject({ result: { stdout: "partial", stderr: "reason", exitCode: 7 } });
    const output = await run("head -c 1100000 /dev/zero");
    expect(output.truncated).toBe(true);
    expect(output.stdout.length).toBe(1024 * 1024);
  });

  it.each(["timeout", "cancel", "close"])("terminates a TERM-resistant sandbox on %s", async (reason) => {
    const controller = new AbortController();
    const marker = `readonly-child-${randomUUID()}`;
    const work = run(`/bin/sh -c 'trap "" TERM; printf started; sleep 30 & wait' ${marker}`, { timeout: reason === "timeout" ? 300 : 5000 }, controller.signal).catch((error) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (reason !== "timeout") timer = setTimeout(() => reason === "close" ? void manager.close() : controller.abort(), 300);
    const error = await work;
    if (timer) clearTimeout(timer);
    expect(error).toBeInstanceOf(ShellError);
    expect(error.result).toMatchObject({ stdout: "started", timedOut: reason === "timeout", cancelled: reason !== "timeout" });
    expect(execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })).not.toContain(marker);
    if (reason === "close") expect(manager.available).toBe(false);
  });

  it("destroys detached children when the foreground command exits normally", async () => {
    const marker = `readonly-detached-${randomUUID()}`;
    expect((await run(`setsid /bin/sh -c 'sleep 30' ${marker} >/dev/null 2>&1 & printf done`)).stdout).toBe("done");
    expect(execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })).not.toContain(marker);
  });

  it("rejects pre-cancelled calls without running their command", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(run("printf should-not-run", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
