import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const MARKER_NAME = ".llm-chat-instance";

export interface InstanceLock {
  dataDir: string;
  markerPath: string;
  release(): Promise<void>;
}

export class InstanceLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstanceLockError";
  }
}

export async function acquireInstanceLock(
  requestedDataDir: string,
  onCompromised: (error: Error) => void
): Promise<InstanceLock> {
  await mkdir(requestedDataDir, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(requestedDataDir);
  const markerPath = resolve(dataDir, MARKER_NAME);
  const marker = await open(markerPath, "a", 0o600);
  await marker.close();
  try { await chmod(markerPath, 0o600); } catch {}

  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(markerPath, {
      realpath: true,
      retries: 0,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      onCompromised(error) {
        onCompromised(new InstanceLockError(
          `数据目录实例锁已失效 (${dataDir})，服务将关闭以避免并发写入`,
          { cause: error }
        ));
      }
    });
  } catch (error) {
    if (isLockHeldError(error)) {
      throw new InstanceLockError(
        `数据目录已被另一个 llm-chat 进程占用 (${dataDir})。请先停止正在运行的服务后再重试。`,
        { cause: error }
      );
    }
    throw new InstanceLockError(`无法锁定数据目录 (${dataDir})`, { cause: error });
  }

  let released = false;
  return {
    dataDir,
    markerPath,
    async release() {
      if (released) return;
      released = true;
      await releaseLock();
    }
  };
}

function isLockHeldError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}
