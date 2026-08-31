import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { parseRuntimeConfig } from "./runtime/config";
import { acquireInstanceLock, type InstanceLock } from "./runtime/instance-lock";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env, projectRoot);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let instanceLock: InstanceLock | undefined;
  let ready = false;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  const removeSignalListeners = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
  const shutdown = (reason: string, exitCode: number): Promise<void> => {
    if (shutdownPromise) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return shutdownPromise;
    }
    closing = true;
    ready = false;
    if (app) app.log.info({ reason, buildId: config.buildId }, "server shutdown started");
    const deadline = setTimeout(() => {
      process.stderr.write(`Shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing exit.\n`);
      process.exit(1);
    }, config.shutdownTimeoutMs);
    shutdownPromise = (async () => {
      try {
        if (app) {
          try {
            await app.runner.close();
          } finally {
            await app.close();
          }
        }
      } finally {
        try {
          await instanceLock?.release();
        } finally {
          instanceLock = undefined;
          process.exitCode = exitCode;
          clearTimeout(deadline);
          removeSignalListeners();
        }
      }
    })();
    return shutdownPromise;
  };
  const fatalShutdown = (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    void shutdown("instance lock compromised", 1).catch((shutdownError) => {
      process.stderr.write(`Fatal shutdown failed: ${formatError(shutdownError)}\n`);
      process.exit(1);
    });
  };
  function onSigterm(): void { void shutdown("SIGTERM", 0).catch(handleShutdownFailure); }
  function onSigint(): void { void shutdown("SIGINT", 0).catch(handleShutdownFailure); }
  function handleShutdownFailure(error: unknown): void {
    process.stderr.write(`Shutdown failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  }

  try {
    instanceLock = await acquireInstanceLock(config.dataDir, fatalShutdown);
    if (config.serveWeb && !existsSync(resolve(config.webRoot, "index.html"))) {
      throw new Error(`Web build artifact is missing: ${resolve(config.webRoot, "index.html")}. Run pnpm build before starting the server.`);
    }
    app = await buildApp({
      dataFile: resolve(instanceLock.dataDir, "llm-chat.sqlite"),
      authMode: config.authMode,
      trustProxy: config.trustProxy,
      publicUrl: config.publicUrl,
      rpId: config.rpId,
      serveWeb: config.serveWeb
    });
    app.get("/healthz", async () => ({ ok: true, buildId: config.buildId }));
    app.get("/readyz", async (_request, reply) => {
      if (!ready || closing) return reply.code(503).send({ ok: false, buildId: config.buildId });
      try {
        app!.store.sqlite.prepare("SELECT 1").get();
        if (config.serveWeb && !existsSync(resolve(config.webRoot, "index.html"))) {
          return reply.code(503).send({ ok: false, buildId: config.buildId });
        }
        return { ok: true, buildId: config.buildId };
      } catch {
        return reply.code(503).send({ ok: false, buildId: config.buildId });
      }
    });
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    const address = await app.listen({ host: config.host, port: config.port });
    ready = true;
    app.log.info({ address, buildId: config.buildId, serveWeb: config.serveWeb }, "server ready");
  } catch (error) {
    try {
      await shutdown("startup failure", 1);
    } catch (shutdownError) {
      process.stderr.write(`Startup cleanup failed: ${formatError(shutdownError)}\n`);
    }
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`Server startup failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});
