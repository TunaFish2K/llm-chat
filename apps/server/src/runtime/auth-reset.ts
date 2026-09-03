import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetPassword } from "../auth";
import { Store } from "../database";
import { loadRuntimeConfig, selectRuntimeConfig } from "./config";
import { acquireInstanceLock } from "./instance-lock";

const CONFIRMATION_FLAG = "--confirm-reset-password";

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const selection = selectRuntimeConfig(process.argv.slice(2), projectRoot);
  if (selection.remainingArgs.length !== 1 || selection.remainingArgs[0] !== CONFIRMATION_FLAG) {
    throw new Error(`拒绝重置：必须传入 ${CONFIRMATION_FLAG}，且只能额外使用 --config <path>`);
  }

  const { config } = await loadRuntimeConfig(selection.configPath, projectRoot, false);
  const dataDir = config.dataDir;
  const instanceLock = await acquireInstanceLock(dataDir, (error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  });
  let store: Store | undefined;
  try {
    store = new Store(resolve(instanceLock.dataDir, "llm-chat.sqlite"));
    const result = await resetPassword(store);
    process.stdout.write([
      "Password authentication reset complete.",
      `sessionsRevoked: ${result.sessionsRevoked}`,
      `initialPassword: ${result.password}`,
      "Use this password to log in, then change it in Settings > Security."
    ].join("\n") + "\n");
  } finally {
    try {
      store?.close();
    } finally {
      await instanceLock.release();
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`Authentication reset failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});
