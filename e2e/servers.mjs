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

try {
  await runBuild();
  const app = startServer("app", appPort, "disabled", join(runDir, "app-data"));
  const auth = startServer("auth", authPort, "webauthn", join(runDir, "auth-data"));
  captureBootstrapUrl(auth, authPort);
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
    detached: process.platform !== "win32",
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
  const host = authMode === "webauthn" ? "::1" : "127.0.0.1";
  const child = spawn("node", ["apps/server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LLM_CHAT_HOST: host,
      LLM_CHAT_PORT: port,
      LLM_CHAT_DATA_DIR: dataDir,
      LLM_CHAT_AUTH_MODE: authMode,
      LLM_CHAT_PUBLIC_URL: `http://localhost:${port}`,
      LLM_CHAT_RP_ID: "localhost"
    },
    detached: process.platform !== "win32",
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

function captureBootstrapUrl(child, port) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1_000_000);
    const match = stderr.match(new RegExp(`http://localhost:${port}/pair#mode=bootstrap&request=[^\\s]+`));
    if (!match) return;
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      appUrl: `http://127.0.0.1:${appPort}`,
      authUrl: `http://localhost:${authPort}`,
      bootstrapUrl: match[0]
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
        if (JSON.parse(state).bootstrapUrl) return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for the authentication bootstrap URL");
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = [...children];
  const closed = active.map((child) => new Promise((resolve) => child.once("close", resolve)));
  for (const child of active) signalChild(child, "SIGTERM");
  await Promise.race([
    Promise.all(closed),
    delay(5_000)
  ]);
  for (const child of children) signalChild(child, "SIGKILL");
  rmSync(runDir, { recursive: true, force: true });
  process.exit(exitCode);
}

function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
