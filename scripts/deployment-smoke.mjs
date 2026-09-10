import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(projectRoot, "apps/server/dist/index.js");
const resetEntry = resolve(projectRoot, "apps/server/dist/auth-reset.js");
const processes = new Set();
let provider;
let tempRoot;
let backgroundPid;
let sessionCookie;

try {
  assert(existsSync(serverEntry), `Built server is missing: ${serverEntry}`);
  assert(existsSync(resetEntry), `Built reset CLI is missing: ${resetEntry}`);
  tempRoot = await mkdtemp(join(tmpdir(), "llm-chat-deploy-"));
  const dataDir = join(tempRoot, "data");
  const workspace = join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const childPidFile = join(workspace, "smoke-child.pid");
  const providerInfo = await startProvider(childPidFile);
  provider = providerInfo.server;
  const port = await availablePort();
  const secondPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = join(tempRoot, "config.json");
  const secondConfigPath = join(tempRoot, "second.config.json");
  await writeConfig(configPath, {
    host: "127.0.0.1",
    port,
    dataDir
  });
  await writeConfig(secondConfigPath, {
    host: "127.0.0.1",
    port: secondPort,
    dataDir
  });
  const legacyEnv = {
    ...process.env,
    LLM_CHAT_HOST: "0.0.0.0",
    LLM_CHAT_PORT: String(secondPort),
    LLM_CHAT_DATA_DIR: join(tempRoot, "ignored-data"),
    LLM_CHAT_AUTH_MODE: "disabled",
    LLM_CHAT_SERVE_WEB: "false",
    LLM_CHAT_BUILD_ID: "ignored-environment"
  };
  const server = launchNode([serverEntry, "--config", configPath], legacyEnv);

  await waitForHttp(`${baseUrl}/healthz`, server, 20_000);
  const health = await fetchJson(`${baseUrl}/healthz`);
  assert(health.response.status === 200 && health.body.ok === true, "healthz did not report liveness");
  const { buildId } = JSON.parse(await readFile(resolve(projectRoot, "apps/server/dist/build-info.json"), "utf8"));
  assert(health.body.buildId === buildId && buildId !== "development", "healthz did not surface the compiled buildId");
  const readiness = await fetchJson(`${baseUrl}/readyz`);
  assert(readiness.response.status === 200 && readiness.body.ok === true, "readyz did not report readiness");
  assert(readiness.body.buildId === buildId, "readyz did not surface buildId");
  assert((await fetch(`${baseUrl}/api/bootstrap`)).status === 401, "API accepted an unauthenticated request");
  const password = server.output().match(/初始登录密码：(\d{8})/)?.[1];
  assert(password, "initial password was not announced");
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", "x-llm-chat-request": "1" },
    body: JSON.stringify({ password })
  });
  assert(login.ok, "password login failed");
  sessionCookie = login.headers.get("set-cookie").split(";", 1)[0];
  await assertImmediateEventStream(baseUrl);

  const index = await fetch(`${baseUrl}/`);
  const indexBody = await index.text();
  assert(index.status === 200, `index returned ${index.status}`);
  const scriptPath = indexBody.match(/src="([^"]+\.js)"/)?.[1];
  assert(scriptPath, "index did not reference a JavaScript asset");
  const currentAsset = await fetch(new URL(scriptPath, baseUrl));
  assert(currentAsset.status === 200, `current JavaScript asset returned ${currentAsset.status}`);
  assert((currentAsset.headers.get("content-type") ?? "").includes("javascript"), "current asset has the wrong MIME type");
  const staleAsset = await fetch(`${baseUrl}/assets/index-stale.js`);
  assert(staleAsset.status === 404, `stale asset returned ${staleAsset.status}`);
  assert((staleAsset.headers.get("content-type") ?? "").includes("text/plain"), "stale asset did not return text/plain");
  assert(await staleAsset.text() === "Asset not found", "stale asset returned HTML instead of the not-found text");

  const second = launchNode([serverEntry, "--config", secondConfigPath], legacyEnv);
  const secondExit = await waitForExit(second, 10_000);
  assert(secondExit.code !== 0, "a second server acquired the same data directory");
  assert(/另一个 llm-chat 进程占用|already.*(?:held|use)/i.test(second.output()), "second server did not report an actionable lock error");

  const activeReset = launchNode([
    resetEntry,
    "--config",
    configPath,
    "--confirm-reset-password"
  ], legacyEnv);
  const activeResetExit = await waitForExit(activeReset, 10_000);
  assert(activeResetExit.code !== 0, "auth reset succeeded while the server held the data lock");
  assert(/另一个 llm-chat 进程占用|already.*(?:held|use)/i.test(activeReset.output()), "active reset did not report the instance lock");

  const bootstrap = await apiJson(baseUrl, "/api/bootstrap");
  const agentId = bootstrap.settings.defaultAgentId;
  const agent = await apiJson(baseUrl, `/api/agents/${agentId}`);
  const connection = await apiJson(baseUrl, "/api/connections", {
    method: "POST",
    body: {
      name: "Deployment smoke provider",
      protocol: "openai-chat",
      baseUrl: providerInfo.baseUrl,
      apiKey: "smoke",
      secretHeaders: {}
    }
  });
  const model = await apiJson(baseUrl, "/api/models", {
    method: "POST",
    body: {
      connectionId: connection.id,
      modelKey: "smoke-model",
      displayName: "Smoke Model",
      contextWindow: 65536,
      maxOutputTokens: 256,
      capabilities: {
        tools: true,
        temperature: true,
        topP: true,
        reasoning: false,
        reasoningSummary: false,
        adaptiveThinking: false,
        manualThinking: false
      },
      defaultSettings: { common: { maxOutputTokens: 256, stopSequences: [] }, protocol: {} },
      enabled: true
    }
  });
  await apiJson(baseUrl, `/api/agents/${agentId}`, {
    method: "PATCH",
    body: {
      execution: {
        ...agent.execution,
        modelId: model.id,
        tools: {
          ...agent.execution.tools,
          approvalOverrides: { ...agent.execution.tools.approvalOverrides, background_start: "never" }
        }
      }
    }
  });
  await apiJson(baseUrl, "/api/conversations/start", {
    method: "POST",
    body: { text: "start the smoke child", agentId, greetingIndex: 0, workspacePath: workspace, executionOverrides: {} }
  });
  backgroundPid = Number((await waitForFile(childPidFile, 10_000)).trim());
  assert(Number.isInteger(backgroundPid) && processExists(backgroundPid), "background child did not start");

  server.child.kill("SIGTERM");
  const drainingDeadline = Date.now() + 2_000;
  let draining = false;
  while (Date.now() < drainingDeadline && !draining) {
    try {
      const probe = await fetchJson(`${baseUrl}/readyz`);
      draining = probe.response.status === 503 && probe.body.ok === false && probe.body.buildId === buildId;
    } catch (error) {
      // Fastify can close its listener before background cleanup finishes.
      if (["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)) draining = true;
      else throw error;
    }
    if (!draining) await delay(20);
  }
  assert(draining, "the service remained ready while shutting down");
  const serverExit = await waitForExit(server, 35_000);
  assert(serverExit.code === 0, `SIGTERM shutdown exited ${serverExit.code}: ${server.output()}`);
  assert(!processExists(backgroundPid), `background child ${backgroundPid} survived server shutdown`);

  const restarted = launchNode([serverEntry, "--config", configPath], legacyEnv);
  await waitForHttp(`${baseUrl}/readyz`, restarted, 20_000);
  assert((await fetchJson(`${baseUrl}/readyz`)).body.buildId === buildId, "restart changed the compiled buildId");
  assert((await fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie: sessionCookie } })).ok, "restart lost the password session");
  restarted.child.kill("SIGTERM");
  assert((await waitForExit(restarted, 35_000)).code === 0, "restarted service did not close cleanly");

  const reset = launchNode([
    resetEntry,
    "--config",
    configPath,
    "--confirm-reset-password"
  ], legacyEnv);
  const resetExit = await waitForExit(reset, 10_000);
  assert(resetExit.code === 0, `offline auth reset failed: ${reset.output()}`);
  for (const field of ["sessionsRevoked", "initialPassword"]) {
    assert(new RegExp(`${field}: \\d+`).test(reset.output()), `offline auth reset omitted ${field}`);
  }
  assert(/Use this password to log in/i.test(reset.output()), "offline auth reset omitted login guidance");
  const unconfirmedReset = launchNode([resetEntry, "--config", configPath], legacyEnv);
  const unconfirmedExit = await waitForExit(unconfirmedReset, 10_000);
  assert(unconfirmedExit.code !== 0, "auth reset accepted a missing confirmation flag");
  assert(unconfirmedReset.output().includes("--confirm-reset-password"), "auth reset did not explain the required confirmation flag");
  const missingConfigReset = launchNode([
    resetEntry,
    "--config",
    join(tempRoot, "missing.json"),
    "--confirm-reset-password"
  ], legacyEnv);
  const missingConfigExit = await waitForExit(missingConfigReset, 10_000);
  assert(missingConfigExit.code !== 0, "auth reset generated a missing config file");
  assert(missingConfigReset.output().includes("无法读取配置文件"), "auth reset did not report its missing config file");

  await assertRequiredWebArtifact(buildId);
  process.stdout.write("Deployment smoke passed.\n");
} finally {
  for (const processInfo of processes) {
    if (processInfo.child.exitCode === null && processInfo.child.signalCode === null) {
      try { processInfo.child.kill("SIGKILL"); } catch {}
      try { await waitForExit(processInfo, 5_000); } catch {}
    }
  }
  if (backgroundPid && processExists(backgroundPid)) {
    try { process.kill(-backgroundPid, "SIGKILL"); } catch {
      try { process.kill(backgroundPid, "SIGKILL"); } catch {}
    }
  }
  if (provider) await new Promise((resolvePromise) => provider.close(resolvePromise));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

async function assertRequiredWebArtifact(buildId) {
  const release = join(tempRoot, "isolated-release");
  const serverRoot = join(release, "apps/server");
  const webRoot = join(release, "apps/web/dist");
  await cp(resolve(projectRoot, "apps/server/dist"), join(serverRoot, "dist"), { recursive: true });
  await symlink(resolve(projectRoot, "apps/server/node_modules"), join(serverRoot, "node_modules"), "dir");
  const configPath = join(release, "config.json");
  const port = await availablePort();
  await writeConfig(configPath, { host: "127.0.0.1", port, dataDir: "./data" });
  const entry = join(serverRoot, "dist/index.js");
  const missing = launchNode([entry, "--config", configPath], process.env);
  assert((await waitForExit(missing, 10_000)).code !== 0, "server started without a Web artifact");
  assert(missing.output().includes("Web build artifact is missing"), "missing Web artifact was not explained");
  await mkdir(webRoot, { recursive: true });
  const index = join(webRoot, "index.html");
  await writeFile(index, "<!doctype html><title>Web readiness test</title>");
  const server = launchNode([entry, "--config", configPath], process.env);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/readyz`, server, 20_000);
  assert((await fetchJson(`${baseUrl}/readyz`)).body.buildId === buildId, "moving the release changed its identity");
  await rm(index);
  const missingProbe = await fetchJson(`${baseUrl}/readyz`);
  assert(missingProbe.response.status === 503 && missingProbe.body.ok === false, "readiness ignored the missing Web artifact");
  assert((await fetchJson(`${baseUrl}/healthz`)).response.status === 200, "Web readiness failure affected liveness");
  server.child.kill("SIGTERM");
  assert((await waitForExit(server, 35_000)).code === 0, "isolated release did not close cleanly");
}

async function startProvider(childPidFile) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      requestCount += 1;
      const first = requestCount === 1;
      const delta = first ? {
        tool_calls: [{
          index: 0,
          id: "deployment-smoke-task",
          type: "function",
          function: {
            name: "background_start",
            arguments: JSON.stringify({
              command: `echo $$ > ${JSON.stringify(childPidFile)}; trap '' TERM; while :; do sleep 1; done`,
              mode: "pipe"
            })
          }
        }]
      } : { content: "started" };
      const frame = { choices: [{ delta, finish_reason: first ? "tool_calls" : "stop" }] };
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object", "provider did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function writeConfig(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function assertImmediateEventStream(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal, headers: { cookie: sessionCookie } });
    assert(response.status === 200, `event stream returned ${response.status}`);
    assert((response.headers.get("content-type") ?? "").includes("text/event-stream"), "event stream has the wrong MIME type");
    const reader = response.body?.getReader();
    assert(reader, "event stream has no response body");
    const { value, done } = await reader.read();
    assert(!done && new TextDecoder().decode(value).includes(": connected"), "event stream did not send its initial frame");
    await reader.cancel();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("event stream did not open within 1500 ms");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function launchNode(args, env) {
  const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const info = { child, output: () => `${stdout}\n${stderr}` };
  processes.add(info);
  return info;
}

async function waitForExit(processInfo, timeoutMs) {
  if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) {
    processes.delete(processInfo);
    return { code: processInfo.child.exitCode, signal: processInfo.child.signalCode };
  }
  let timer;
  try {
    const result = await Promise.race([
      new Promise((resolvePromise, rejectPromise) => {
        processInfo.child.once("error", rejectPromise);
        processInfo.child.once("close", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`process timeout: ${processInfo.output()}`)), timeoutMs);
      })
    ]);
    processes.delete(processInfo);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForHttp(url, processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null) throw new Error(`server exited before readiness: ${processInfo.output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server did not become ready: ${processInfo.output()}`);
}

async function apiJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { cookie: sessionCookie, "x-llm-chat-request": "1", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  assert(response.ok, `${options.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  return body;
}

async function fetchJson(url) {
  const response = await fetch(url);
  return { response, body: await response.json() };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object", "temporary TCP listener has no address");
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); } catch {}
    await delay(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
