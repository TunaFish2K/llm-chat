import { spawn } from "node:child_process";

export class ShellError extends Error {
  readonly code: number | null;
  constructor(readonly result: ShellResult, message: string) {
    super(message);
    this.name = result.cancelled ? "AbortError" : "ShellError";
    this.code = result.exitCode;
  }
}
export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

export function executeShell(command: string, cwd: string, timeout: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }
    });
    const result: ShellResult = { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, truncated: false };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const kill = (value: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, value); } catch { /* Already exited. */ } }
    };
    const stop = () => {
      if (killTimer || finished) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => { kill("SIGKILL"); finish(); }, 1000);
    };
    const abort = () => { result.cancelled = true; stop(); };
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeout);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) { kill("SIGKILL"); clearTimeout(killTimer); }
      signal.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy();
      if (error || result.cancelled || result.timedOut || result.exitCode !== 0) {
        const message = error?.message ?? (result.cancelled ? "命令已取消" : result.timedOut ? "命令执行超时" : `命令退出码 ${result.exitCode ?? result.signal}`);
        reject(new ShellError(result, message));
      } else resolve(JSON.stringify(result));
    };
    for (const key of ["stdout", "stderr"] as const) {
      child[key].setEncoding("utf8");
      child[key].on("data", (chunk: string) => {
        const next = result[key] + chunk;
        if (next.length > 1024 * 1024) result.truncated = true;
        result[key] = next.slice(-1024 * 1024);
      });
    }
    child.on("error", finish);
    child.on("close", (code, exitSignal) => { result.exitCode = code; result.signal = exitSignal; finish(); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
