export const SHUTDOWN_TIMEOUT_MS = 30_000;

export function startShutdownDeadline(): () => void {
  const timer = setTimeout(() => {
    process.stderr.write(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit.\n`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  return () => clearTimeout(timer);
}
