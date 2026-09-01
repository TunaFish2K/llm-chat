import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate an E2E port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface RuntimeConfig {
  appPort: number;
  authPort: number;
  runDir: string;
  stateFile: string;
}

const worktreeId = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const coordinationFile = join(tmpdir(), `llm-chat-playwright-${worktreeId}.json`);
const ownsRuntime = process.env.TEST_WORKER_INDEX === undefined;
let runtime: RuntimeConfig;
if (!ownsRuntime) {
  runtime = JSON.parse(readFileSync(coordinationFile, "utf8")) as RuntimeConfig;
} else {
  const appPort = await freePort();
  let authPort = await freePort();
  while (authPort === appPort) authPort = await freePort();
  const runDir = join(tmpdir(), `llm-chat-e2e-${process.pid}-${randomUUID()}`);
  runtime = { appPort, authPort, runDir, stateFile: join(runDir, "servers.json") };
  writeFileSync(coordinationFile, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
}
const { appPort, authPort, runDir, stateFile } = runtime;
const appUrl = `http://127.0.0.1:${appPort}`;
const authUrl = `http://localhost:${authPort}`;

if (ownsRuntime) {
  process.once("exit", () => {
    try {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(coordinationFile, { force: true });
    } catch {}
  });
}

process.env.E2E_APP_URL = appUrl;
process.env.E2E_AUTH_URL = authUrl;
process.env.E2E_APP_PORT = String(appPort);
process.env.E2E_AUTH_PORT = String(authPort);
process.env.E2E_RUN_DIR = runDir;
process.env.E2E_STATE_FILE = stateFile;

export default defineConfig({
  testDir: "./e2e",
  outputDir: join(tmpdir(), `llm-chat-playwright-results-${worktreeId}`),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["line"]] : "list",
  use: {
    baseURL: appUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: "node e2e/servers.mjs",
    url: `${appUrl}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      E2E_APP_PORT: String(appPort),
      E2E_AUTH_PORT: String(authPort),
      E2E_RUN_DIR: runDir,
      E2E_STATE_FILE: stateFile
    }
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "mobile-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        screen: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices["Pixel 7"].userAgent
      }
    }
  ]
});
