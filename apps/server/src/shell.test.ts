import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { executeShell, ShellError } from "./shell";

it("retains stdout, stderr and the exit code on command failure", async () => {
  const error = await executeShell("printf partial; printf reason >&2; exit 7", "/tmp", 2000, new AbortController().signal).catch((error) => error);
  expect(error).toBeInstanceOf(ShellError);
  expect(error.result).toMatchObject({ stdout: "partial", stderr: "reason", exitCode: 7, cancelled: false, timedOut: false });
});

it.each(["timeout", "cancel"])("kills a TERM-resistant foreground process group on %s", async (reason) => {
  const controller = new AbortController();
  const result = executeShell("trap '' TERM; sleep 30 & printf '%s' $!; wait", "/tmp", reason === "timeout" ? 150 : 10000, controller.signal).catch((error) => error);
  if (reason === "cancel") setTimeout(() => controller.abort(), 150);
  const error = await result;
  expect(error).toBeInstanceOf(ShellError);
  expect(error.result).toMatchObject({ timedOut: reason === "timeout", cancelled: reason === "cancel" });
  const pid = Number(error.result.stdout);
  expect(pid).toBeGreaterThan(1);
  const stat = `/proc/${pid}/stat`;
  // An orphan can briefly remain as a zombie awaiting reaping, but cannot execute.
  try { expect(readFileSync(stat, "utf8").split(") ")[1]?.[0]).toBe("Z"); }
  catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
});

it("bounds output and reports spawn errors and pre-cancellation", async () => {
  const output = JSON.parse(await executeShell("head -c 1100000 /dev/zero", "/tmp", 3000, new AbortController().signal));
  expect(output.truncated).toBe(true);
  expect(output.stdout.length).toBe(1024 * 1024);
  await expect(executeShell("true", "/nonexistent-llm-chat-directory", 3000, new AbortController().signal)).rejects.toMatchObject({ result: { exitCode: null } });
  const controller = new AbortController(); controller.abort();
  expect(() => executeShell("true", "/tmp", 3000, controller.signal)).toThrow();
});
