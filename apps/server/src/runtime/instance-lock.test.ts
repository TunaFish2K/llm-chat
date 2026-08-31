import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock, InstanceLockError } from "./instance-lock";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("instance lock", () => {
  it("serializes access to a canonical data directory and releases idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "llm-chat-lock-"));
    tempDirs.push(root);
    const dataDir = join(root, "data");
    const compromised = vi.fn();
    const first = await acquireInstanceLock(dataDir, compromised);

    expect(first.dataDir).toBe(await realpath(dataDir));
    await expect(acquireInstanceLock(dataDir, compromised)).rejects.toThrow(InstanceLockError);
    await expect(acquireInstanceLock(dataDir, compromised)).rejects.toThrow("另一个 llm-chat 进程");

    await first.release();
    await first.release();
    const next = await acquireInstanceLock(dataDir, compromised);
    await next.release();
    expect(compromised).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("cannot be bypassed through a symlink alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "llm-chat-lock-alias-"));
    tempDirs.push(root);
    const dataDir = join(root, "data");
    const first = await acquireInstanceLock(dataDir, vi.fn());
    const alias = join(root, "alias");
    await symlink(dataDir, alias, "dir");

    await expect(acquireInstanceLock(alias, vi.fn())).rejects.toThrow("另一个 llm-chat 进程");
    await first.release();
  });
});
