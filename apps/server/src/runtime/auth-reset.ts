import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetPassword } from "../auth";
import { Store } from "../database";
import { acquireInstanceLock } from "./instance-lock";

const CONFIRMATION_FLAG = "--confirm-reset-password";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== CONFIRMATION_FLAG) {
    throw new Error(`拒绝重置：必须且只能传入 ${CONFIRMATION_FLAG}`);
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.LLM_CHAT_DATA_DIR ?? resolve(projectRoot, "data"));
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
