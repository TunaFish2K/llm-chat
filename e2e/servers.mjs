import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const appPort = requiredEnv("E2E_APP_PORT");
const authPort = requiredEnv("E2E_AUTH_PORT");
const runDir = requiredEnv("E2E_RUN_DIR");
const stateFile = requiredEnv("E2E_STATE_FILE");
const children = new Set();
let shuttingDown = false;

mkdirSync(runDir, { recursive: true, mode: 0o700 });
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));
process.once("exit", cleanupRunDir);

try {
  await runBuild();
  const app = startServer("app", appPort, "disabled", join(runDir, "app-data"));
  const auth = startServer("auth", authPort, "password", join(runDir, "auth-data"));
  captureInitialPassword(auth, authPort);
  await Promise.all([
    waitForHealth(`http://127.0.0.1:${appPort}/api/health`),
    waitForHealth(`http://localhost:${authPort}/api/health`),
    waitForState()
  ]);
  process.stdout.write(`E2E servers ready on ${appPort} and ${authPort}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown(1);
}

await new Promise(() => {});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runBuild() {
  const build = spawn("pnpm", ["build"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(build);
  build.stdout.pipe(process.stdout);
  build.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => {
    build.once("error", reject);
    build.once("close", resolve);
  });
  children.delete(build);
  if (code !== 0) throw new Error(`Production build failed with exit code ${code}`);
}

function startServer(name, port, authMode, dataDir) {
  const configPath = join(runDir, `${name}.config.json`);
  writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port: Number(port),
    dataDir,
    authMode,
    trustProxy: false,
    serveWeb: true,
    shutdownTimeoutMs: 30_000,
    buildId: `e2e-${name}`
  }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn("node", ["apps/server/dist/index.js", "--config", configPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.once("error", (error) => {
    process.stderr.write(`[${name}] ${error.stack ?? error.message}\n`);
    void shutdown(1);
  });
  child.once("close", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      process.stderr.write(`[${name}] exited unexpectedly (${signal ?? code})\n`);
      void shutdown(1);
    }
  });
  return child;
}

function captureInitialPassword(child, port) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1_000_000);
    const match = stderr.match(/初始登录密码：(\d{8})/);
    if (!match) return;
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      appUrl: `http://127.0.0.1:${appPort}`,
      authUrl: `http://localhost:${authPort}`,
      initialPassword: match[1]
    })}\n`, { mode: 0o600 });
    renameSync(temporary, stateFile);
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function waitForState() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${authPort}/api/health`);
      if (response.ok) {
        const state = readFileSync(stateFile, "utf8");
        if (JSON.parse(state).initialPassword) return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for the initial authentication password");
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = [...children];
  const closed = active.map(waitForClose);
  for (const child of active) signalChild(child, "SIGTERM");
  await Promise.race([
    Promise.all(closed),
    delay(5_000)
  ]);
  const remaining = [...children];
  for (const child of remaining) signalChild(child, "SIGKILL");
  await Promise.race([
    Promise.all(remaining.map(waitForClose)),
    delay(1_000)
  ]);
  cleanupRunDir();
  process.exit(exitCode);
}

function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {}
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function cleanupRunDir() {
  rmSync(runDir, { recursive: true, force: true });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
