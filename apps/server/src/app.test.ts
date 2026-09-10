import { seedModel as seedStoreModel } from "./test-helpers";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, ModelSettings } from "@llm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import type { InjectOptions } from "fastify";
import { mcpManager } from "./mcp";

const dirs: string[] = [];
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) {
    try { await app.close(); } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server API", () => {
  it("rejects submissions from an unrefreshed client before writing, while legacy sends still work", async () => {
    const app = await testApp();
    seedStoreModel(app.store);
    vi.spyOn(app.runner, "start").mockImplementation(() => {});
    const conversation = app.store.createConversation({ systemPrompt: "" });
    const counts = () => ["conversations", "messages", "generations", "queued_messages"].map((table) =>
      app.store.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    const before = counts();
    for (const url of ["/api/conversations/start", `/api/conversations/${conversation.id}/messages`, `/api/conversations/${conversation.id}/queued-messages`]) {
      const response = await app.inject({ method: "POST", url, payload: {
        clientRequestId: "00000000-0000-4000-8000-000000000001", text: "do not duplicate", agentId: app.store.getSettings().defaultAgentId
      } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: { code: "client_update_required", message: "版本已回退，请刷新页面后重试" } });
      expect(counts()).toEqual(before);
    }
    const started = await app.inject({ method: "POST", url: "/api/conversations/start", payload: {
      text: "normal start", agentId: app.store.getSettings().defaultAgentId
    } });
    expect(started.statusCode).toBe(202);
    const sent = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { text: "normal send" } });
    expect(sent.statusCode).toBe(202);
    const queued = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/queued-messages`, payload: { text: "normal queue" } });
    expect(queued.statusCode).toBe(202);
    expect(app.store.listQueuedMessages(conversation.id)).toEqual([expect.objectContaining({ text: "normal queue" })]);
  });

  it("requires a Web artifact before opening the application", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-missing-web-"));
    dirs.push(dir);
    await expect(buildApp({ dataFile: join(dir, "test.sqlite"), logger: false, webRoot: join(dir, "missing") }))
      .rejects.toThrow("Web build artifact is missing");
  });

  it("ignores forwarded protocol and IP headers for cookies and login rate limits", async () => {
    const app = await testApp();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: app.password },
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.1" } });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("llm_chat_session=");
    expect(login.headers["set-cookie"]).not.toContain("Secure");
    expect(login.headers["set-cookie"]).not.toContain("__Host-");
    for (let index = 0; index < 6; index++) {
      const failed = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong-password" },
        headers: { "x-forwarded-for": `192.0.2.${index + 2}` } });
      expect(failed.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong-password" },
      headers: { "x-forwarded-for": "198.51.100.1" } });
    expect(limited.statusCode).toBe(429);
  });

  it("rejects deleting a family with an active image job in a hidden branch", async () => {
    const app = await testApp();
    const store = app.store;
    const { model, connection } = seedStoreModel(store);
    const imageModel = store.updateModel(model.id, { imageProtocol: "openai-images", capabilities: { ...model.capabilities, imageOutput: true } })!;
    const root = store.createConversation({ systemPrompt: "" });
    const child = store.forkConversation(root.id, { mode: "continue", throughMessageId: null }).conversation;
    const job = store.createImageGenerationJob({ conversationId: child.id,
      assistantMessageId: store.createImageAssistantMessage(child.id), model: imageModel,
      connection: store.getConnection(connection.id)!, request: {
        modelId: model.id, prompt: "beach", operation: "generate", referenceAssetIds: [], count: 1
      } });
    const blocked = await app.inject({ method: "DELETE", url: `/api/conversations/${root.id}` });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("conversation_image_tasks_active");
    expect(store.getConversation(root.id)).toBeDefined();
    expect(store.getImageGenerationJob(job.id)?.status).toBe("queued");
    store.updateImageGenerationJob(job.id, { status: "cancelled", completedAt: Date.now() });
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${root.id}` })).statusCode).toBe(204);
    expect(store.getConversation(child.id)).toBeUndefined();
    expect(store.getImageGenerationJob(job.id)).toBeUndefined();
  });

  it("rejects retired global generation settings and saves Agent-owned prompts", async () => {
    const app = await testApp();
    const settings = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    for (const field of ["defaultModelId", "defaultContextPolicy", "reasoningEffort", "defaultSystemPrompt"]) {
      expect(settings).not.toHaveProperty(field);
      const response = await app.inject({ method: "PATCH", url: "/api/settings", payload: { [field]: "old value" } });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("生成配置已移至 Agent");
    }
    const agent = app.store.getAgent(settings.defaultAgentId)!;
    const response = await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload: {
      execution: { ...agent.execution, baseSystemPrompt: "Agent rules" }
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().execution.baseSystemPrompt).toBe("Agent rules");
    const { baseSystemPrompt: _base, ...legacyExecution } = agent.execution;
    const legacyUpdate = await app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, payload: { execution: legacyExecution } });
    expect(legacyUpdate.json().execution.baseSystemPrompt).toBe("Agent rules");
  });

  it("persists pre-send model selections and applies them when creating a conversation", async () => {
    const app = await testApp(); const model = await createApiModel(app);
    const id = app.store.getSettings().defaultAgentId;
    const agent = app.store.getAgent(id)!;
    app.store.updateAgent(id, { execution: { ...agent.execution, modelId: null } });
    const selection = await app.inject({ method: "PATCH", url: `/api/agents/${id}/model-selection`, payload: { modelId: model.id } });
    expect(selection.statusCode).toBe(200);
    expect(selection.json()).toMatchObject({ lastSelectedModelId: model.id, execution: { modelId: null } });
    const bootstrap = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json();
    expect(bootstrap.agents.find((item: { id: string }) => item.id === id).lastSelectedModelId).toBe(model.id);
    const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { agentId: id } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ modelId: model.id, executionOverrides: { modelId: model.id } });
    const patch = await app.inject({ method: "PATCH", url: `/api/conversations/${created.json().id}`, payload: { modelId: model.id } });
    expect(patch.statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/agents/${id}/model-selection`, payload: { modelId: "invalid" } })).statusCode).toBe(400);
  });

  it("searches active message text and empty conversation titles, escapes wildcards and rejects oversized queries", async () => {
    const app = await testApp(); const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "正文 needle 100%", modelId: model.id, contextPolicy: "full" });
    app.store.finishGeneration(started.generation.generationId, "completed", {});
    app.store.updateConversation(started.conversation.id, { title: "正文命中" });
    const title = app.store.createConversation({ title: "needle title", systemPrompt: "" });
    const response = (await app.inject({ method: "GET", url: "/api/conversations/search?query=needle" })).json();
    expect(response.map((item: { conversationId: string }) => item.conversationId)).toEqual([title.id, started.conversation.id]);
    expect(response[1].snippet).toContain("needle");
    expect((await app.inject({ method: "GET", url: "/api/conversations/search?query=%25" })).json()).toHaveLength(1);
    app.store.sqlite.prepare("UPDATE messages SET history_active = 0 WHERE conversation_id = ?").run(started.conversation.id);
    expect((await app.inject({ method: "GET", url: "/api/conversations/search?query=needle" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/conversations/search?query=${"x".repeat(201)}` })).statusCode).toBe(400);
  });

  it("retires history mutations without cancelling work, and exposes paused queues independently", async () => {
    const app = await testApp(); const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "original", modelId: model.id, contextPolicy: "full" });
    const id = started.conversation.id;
    app.store.setGenerationWaitingApproval(started.generation.generationId);
    app.store.sqlite.prepare("UPDATE conversations SET queue_paused = 1 WHERE id = ?").run(id);
    const item = app.store.enqueueMessage(id, "waiting", [], "steer");
    const original = app.store.listMessages(id);
    for (const action of ["undo", "redo", "rewind"]) {
      const response = await app.inject({ method: "POST", url: `/api/conversations/${id}/history`, payload: { action, revision: 0 } });
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe("history_retired");
    }
    expect(app.store.listMessages(id)).toEqual(original);
    expect(app.store.getGeneration(started.generation.generationId)?.status).toBe("waiting-approval");
    expect((await app.inject({ method: "GET", url: `/api/conversations/${id}/queue` })).json()).toMatchObject({ paused: true, items: [{ id: item.id, mode: "steer" }] });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${id}/history` })).json()).toEqual({
      revision: 0, canUndo: false, canRedo: false, records: [], queuePaused: true
    });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${id}/queued-messages` })).json()).toHaveLength(1);
    await app.inject({ method: "POST", url: `/api/conversations/${id}/queue/resume` });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${id}/queue` })).json()).toMatchObject({ paused: false, items: [{ id: item.id }] });
    expect((await app.inject({ method: "GET", url: "/api/conversations/missing/queue" })).statusCode).toBe(404);
  });

  it("persists queued attachments and supports scoped deletion while a generation is waiting", async () => {
    const app = await testApp();
    const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "first", modelId: model.id, contextPolicy: "full" });
    app.store.setGenerationWaitingApproval(started.generation.generationId);
    const path = `/api/conversations/${started.conversation.id}/queued-messages`;
    const asset = app.store.createFileAsset({ sha256: "a".repeat(64), fileName: "a.txt", mimeType: "text/plain", kind: "file", byteSize: 1, storageKey: "test" });
    const a = await app.inject({ method: "POST", url: path, payload: { text: "", assetIds: [asset.id] } });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toMatchObject({ status: "pending", attachments: [{ id: asset.id }] });
    const b = await app.inject({ method: "POST", url: path, payload: { text: "b" } });
    expect((await app.inject({ method: "POST", url: path, payload: { text: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/conversations/${started.conversation.id}/messages`, payload: { text: "bypass" } })).json())
      .toMatchObject({ error: { code: "conversation_busy" } });
    expect((await app.inject({ method: "DELETE", url: `${path}/${b.json().id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: path })).json()).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: path })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: path })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/conversations/missing/queued-messages" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/generations/${started.generation.generationId}/cancel` })).json()).toEqual({ ok: true, status: "stopped" });
  });

  it("serves immutable image assets through SHA-256 cache URLs", async () => {
    const app = await testApp();
    const dataBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/images",
      payload: { fileName: "pixel.png", dataBase64 }
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json();
    expect(asset.url).toBe(`/api/images/${asset.id}?v=${asset.sha256}`);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);

    const first = await app.inject({ method: "GET", url: asset.url });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("image/png");
    expect(first.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(first.headers.etag).toBe(`"${asset.sha256}"`);
    expect(first.rawPayload.equals(Buffer.from(dataBase64, "base64"))).toBe(true);

    const canonical = await app.inject({ method: "GET", url: `/api/images/${asset.id}?v=wrong` });
    expect(canonical.statusCode).toBe(307);
    expect(canonical.headers.location).toBe(asset.url);
    expect(canonical.headers["cache-control"]).toBe("no-store");

    const cached = await app.inject({
      method: "GET",
      url: asset.url,
      headers: { "if-none-match": first.headers.etag! }
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

    const privateProxy = await app.inject({
      method: "GET",
      url: "/api/image-proxy?url=http%3A%2F%2F127.0.0.1%2Fsecret.png"
    });
    expect(privateProxy.statusCode).toBe(400);
    expect(privateProxy.json()).toMatchObject({ error: { code: "image_proxy_private_address" } });
  });

  it("uploads arbitrary files and serves immutable, ranged downloads without trusting their MIME type", async () => {
    const app = await testApp();
    const bytes = Buffer.from("0123456789", "utf8");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/files",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("report.html"),
        "x-file-type": "text/html"
      },
      payload: bytes
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json();
    expect(asset).toMatchObject({ fileName: "report.html", mimeType: "text/html", kind: "file", byteSize: 10 });
    expect(asset.url).toBe(`/api/files/${asset.id}?v=${asset.sha256}`);

    const complete = await app.inject({ method: "GET", url: asset.url });
    expect(complete.statusCode).toBe(200);
    expect(complete.headers["content-type"]).toContain("application/octet-stream");
    expect(complete.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''report.html");
    expect(complete.headers["x-content-type-options"]).toBe("nosniff");
    expect(complete.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(complete.rawPayload.equals(bytes)).toBe(true);

    const range = await app.inject({ method: "GET", url: asset.url, headers: { range: "bytes=2-5" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe("bytes 2-5/10");
    expect(range.body).toBe("2345");
    const invalid = await app.inject({ method: "GET", url: asset.url, headers: { range: "bytes=99-100" } });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers["content-range"]).toBe("bytes */10");
  });

  it("protects password APIs with request-source and session checks without a configured public origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-auth-api-"));
    dirs.push(dir);
    let initialPassword = "";
    const app = await buildApp({
      dataFile: join(dir, "test.sqlite"), logger: false, webRoot: testWebRoot(dir),
      authAnnounce: (message) => { initialPassword = message.match(/\d{8}/)?.[0] ?? ""; },
      skillDiscoveryRoot: join(dir, "agent-skills")
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    const protectedRoute = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(protectedRoute.statusCode).toBe(401);
    expect(protectedRoute.json()).toMatchObject({ error: { code: "authentication_required" } });
    expect(initialPassword).toMatch(/^\d{8}$/);
    const missingSource = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: initialPassword } });
    expect(missingSource.statusCode).toBe(403);
    expect(missingSource.json()).toMatchObject({ error: { code: "request_header_required" } });
    for (const fetchSite of ["cross-site", "same-site"]) {
      const crossSite = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { password: initialPassword },
        headers: {
          "x-llm-chat-request": "1",
          "sec-fetch-site": fetchSite,
          origin: "https://attacker.example"
        }
      });
      expect(crossSite.statusCode).toBe(403);
      expect(crossSite.json()).toMatchObject({ error: { code: "cross_site_request_rejected" } });
    }
    const wrong = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { password: "00000000" },
      headers: { "x-llm-chat-request": "1", "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: "password_invalid" } });
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { password: initialPassword },
      headers: { "x-llm-chat-request": "1", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3000" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("llm_chat_session=");
    expect(login.headers["set-cookie"]).not.toContain("Secure");
    const setCookie = login.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(";", 1)[0]!;
    const authenticated = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie } });
    expect(authenticated.statusCode).toBe(200);
    const tooShort = await app.inject({
      method: "PUT", url: "/api/auth/password", payload: { password: "short" },
      headers: { cookie, "x-llm-chat-request": "1", origin: "http://chat.internal" }
    });
    expect(tooShort.statusCode).toBe(400);
    const changed = await app.inject({
      method: "PUT", url: "/api/auth/password", payload: { password: "new-password-123" },
      headers: { cookie, "x-llm-chat-request": "1", origin: "http://chat.internal" }
    });
    expect(changed.statusCode).toBe(200);
    const changedSetCookie = changed.headers["set-cookie"]!;
    const changedCookie = (Array.isArray(changedSetCookie) ? changedSetCookie[0]! : changedSetCookie).split(";", 1)[0]!;
    expect((await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie: changedCookie } })).statusCode).toBe(200);
  });

  it("never returns API key values from connection endpoints", async () => {
    const app = await testApp();
    const created = await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Private", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "secret-value", secretHeaders: { "X-Key": "header-value" }
    } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("secret-value");
    expect(created.body).not.toContain("header-value");
    const listed = await app.inject({ method: "GET", url: "/api/connections" });
    expect(listed.body).not.toContain("secret-value");
    await app.close();
  });

  it("fetches configured connection balances with cache, refresh, and sanitized errors", async () => {
    const app = await testApp();
    const missing = await app.inject({ method: "GET", url: "/api/connections/missing/balance" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "connection_not_found" } });

    const created = (await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Balance", protocol: "openai-chat", baseUrl: "https://provider.test/v1",
      apiKey: "route-secret", secretHeaders: { "X-Secret": "header-secret" }
    } })).json();
    const disabled = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance` });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toMatchObject({ error: { code: "balance_disabled" } });

    const configured = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      payload: {
        balanceConfig: { enabled: true, apiPath: "/account/balance", resultExpression: "data.cents / 100" }
      }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain("route-secret");
    let cents = 1250;
    const fetchMock = vi.fn(async () => Response.json({ data: { cents } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ connectionId: created.id, value: 12.5, cached: false, fetchedAt: expect.any(Number) });
    cents = 2000;
    const cached = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance` });
    expect(cached.json()).toMatchObject({ value: 12.5, cached: true });
    const refreshed = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance?refresh=true` });
    expect(refreshed.json()).toMatchObject({ value: 20, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await app.inject({
      method: "PATCH", url: `/api/connections/${created.id}`,
      payload: { balanceConfig: { enabled: true, apiPath: "/account/balance", resultExpression: "data.missing" } }
    });
    const invalid = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance` });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ error: { code: "balance_invalid_result" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "route-secret header-secret" } }), { status: 401 }
    )));
    await app.inject({
      method: "PATCH", url: `/api/connections/${created.id}`,
      payload: { balanceConfig: { enabled: true, apiPath: "/account/failed", resultExpression: "data.cents" } }
    });
    const upstream = await app.inject({ method: "GET", url: `/api/connections/${created.id}/balance` });
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json()).toMatchObject({ error: { code: "balance_upstream_error" } });
    expect(upstream.body).not.toContain("route-secret");
    expect(upstream.body).not.toContain("header-secret");
  });

  it("runs a generation in the background and persists the final snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { reasoning_content: "思考" } }] },
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    ])));
    const app = await testApp();
    const connection = (await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Mock", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {}
    } })).json();
    const settings: ModelSettings = {
      common: { maxOutputTokens: 128, stopSequences: [] },
      protocol: { reasoningEffort: "high", verbosity: "low" }
    };
    const modelInput: ModelInput = {
      connectionId: connection.id,
      modelKey: "mock",
      displayName: "Mock",
      contextWindow: 65536,
      maxOutputTokens: 128,
      capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
      defaultSettings: settings,
      enabled: true
    };
    const model = (await app.inject({ method: "POST", url: "/api/models", payload: modelInput })).json();
    const defaultAgentId = (await app.inject({ method: "GET", url: "/api/settings" })).json().defaultAgentId;
    const defaultAgent = (await app.inject({ method: "GET", url: `/api/agents/${defaultAgentId}` })).json();
    await app.inject({ method: "PATCH", url: `/api/agents/${defaultAgentId}`, payload: {
      execution: { ...defaultAgent.execution, modelId: model.id, baseSystemPrompt: "系统提示", reasoningEffort: "low" }
    } });
    const startResponse = await app.inject({
      method: "POST",
      url: "/api/conversations/start",
      payload: agentStartPayload(app, model.id, { text: "你好", contextPolicy: "summarize", reasoningEffort: "low" })
    });
    expect(startResponse.statusCode).toBe(202);
    const started = startResponse.json();
    const conversation = started.conversation;
    expect(conversation).toMatchObject({
      title: "你好",
      modelId: model.id,
      systemPrompt: "",
      contextPolicy: "summarize"
    });
    const generation = await waitForGeneration(app, started.generation.generationId);
    expect(generation).toMatchObject({ status: "completed", usage: { totalTokens: 6 } });
    // Effective settings carry the request effort and no legacy reasoning knobs.
    expect(generation.settings.reasoningEffort).toBe("low");
    expect(generation.settings.protocol.reasoningEffort).toBeUndefined();
    expect(generation.settings.protocol.verbosity).toBeUndefined();
    expect(generation.settings.common.maxOutputTokens).toBe(128);
    expect(generation.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", content: "思考" }),
      expect.objectContaining({ type: "text", content: "完成" })
    ]));
    const messages = (await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/messages` })).json();
    expect(messages[0].generatedModel).toBeNull();
    expect(messages[2].generatedModel).toMatchObject({ modelId: model.id, displayName: "Mock" });
    await app.close();
  });

  it("does not create a conversation when start validation fails", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/start",
      payload: agentStartPayload(app, "00000000-0000-4000-8000-000000000000", { text: "你好" })
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "model_not_found" } });
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json()).toEqual([]);
    await app.close();
  });

  it("rejects a start that enables reasoning on a non-reasoning model", async () => {
    const app = await testApp();
    const connection = (await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Mock", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {}
    } })).json();
    const model = (await app.inject({ method: "POST", url: "/api/models", payload: {
      connectionId: connection.id,
      modelKey: "plain",
      displayName: "Plain",
      contextWindow: 2048,
      maxOutputTokens: 128,
      capabilities: { tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
      defaultSettings: { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {} },
      enabled: true
    } })).json();
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { reasoningEffort: "high" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/start",
      payload: agentStartPayload(app, model.id, { text: "你好", reasoningEffort: "high" })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "reasoning_not_supported" } });
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json()).toEqual([]);
    await app.close();
  });

  it("requires a conversation model before sending", async () => {
    const app = await testApp();
    const conversation = (await app.inject({ method: "POST", url: "/api/conversations", payload: {
      agentId: app.store.getSettings().defaultAgentId
    } })).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "你好" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "conversation_model_required" } });
    await app.close();
  });

  it("uses conversation reasoning overrides for start, send, and retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ])));
    const app = await testApp();
    const connection = (await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Mock", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {}
    } })).json();
    const model = (await app.inject({ method: "POST", url: "/api/models", payload: {
      connectionId: connection.id,
      modelKey: "mock",
      displayName: "Mock",
      contextWindow: 2048,
      maxOutputTokens: 128,
      capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
      defaultSettings: { common: { maxOutputTokens: 128, stopSequences: [] }, protocol: {} },
      enabled: true
    } })).json();
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { reasoningEffort: "medium" } });
    const started = (await app.inject({
      method: "POST", url: "/api/conversations/start", payload: agentStartPayload(app, model.id, { text: "你好", reasoningEffort: "medium" })
    })).json();
    const conversationId = started.conversation.id as string;
    let generation = await waitForGeneration(app, started.generation.generationId);
    expect(generation.settings.reasoningEffort).toBe("medium");

    await app.inject({ method: "PATCH", url: `/api/conversations/${conversationId}`, payload: {
      executionOverrides: { modelId: model.id, reasoningEffort: "xhigh" }
    } });
    const sendResponse = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "第二条" }
    });
    expect(sendResponse.statusCode).toBe(202);
    const message = sendResponse.json();
    generation = await waitForGeneration(app, message.generationId);
    expect(generation.settings.reasoningEffort).toBe("xhigh");

    await app.inject({ method: "PATCH", url: `/api/conversations/${conversationId}`, payload: {
      executionOverrides: { modelId: model.id, reasoningEffort: "max" }
    } });
    const assistantMessageId = started.generation.assistantMessageId as string;
    const retriedResponse = await app.inject({
      method: "POST", url: `/api/messages/${assistantMessageId}/generations`,
      payload: {}
    });
    expect(retriedResponse.statusCode).toBe(202);
    const retried = retriedResponse.json();
    generation = await waitForGeneration(app, retried.generationId);
    expect(generation.settings.reasoningEffort).toBe("max");
    await app.close();
  });

  it("creates immutable conversation forks and exposes sanitized context checkpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }
    ])));
    const app = await testApp();
    const model = await createApiModel(app);
    const started = (await app.inject({
      method: "POST", url: "/api/conversations/start", payload: agentStartPayload(app, model.id, { text: "原问题", contextPolicy: "auto" })
    })).json();
    await waitForGeneration(app, started.generation.generationId);
    const sourceMessages = (await app.inject({
      method: "GET", url: `/api/conversations/${started.conversation.id}/messages`
    })).json();
    const sourceUser = sourceMessages.find((message: { role: string }) => message.role === "user");

    const editedResponse = await app.inject({
      method: "POST",
      url: `/api/conversations/${started.conversation.id}/forks`,
      payload: { mode: "edit", messageId: sourceUser.id, text: "修改后的问题" }
    });
    expect(editedResponse.statusCode).toBe(202);
    const edited = editedResponse.json();
    expect(edited.conversation.forkedFrom).toEqual({
      conversationId: started.conversation.id,
      messageId: sourceUser.id,
      messageOrdinal: sourceUser.ordinal,
      mode: "edit",
      greetingIndex: null,
      sourceGreetingIndex: null
    });
    expect(edited.generation).toMatchObject({ generationId: expect.any(String) });
    await waitForGeneration(app, edited.generation.generationId);
    const editedMessages = (await app.inject({
      method: "GET", url: `/api/conversations/${edited.conversation.id}/messages`
    })).json();
    expect(editedMessages.find((message: { role: string }) => message.role === "user"))
      .toMatchObject({ role: "user", text: "修改后的问题" });
    expect((await app.inject({
      method: "GET", url: `/api/conversations/${started.conversation.id}/messages`
    })).json().find((message: { role: string }) => message.role === "user")).toMatchObject({ text: "原问题" });

    app.store.saveSummary({
      conversationId: started.conversation.id,
      throughOrdinal: 2,
      fingerprint: "private-fingerprint",
      text: "较早对话摘要",
      connectionId: model.connectionId,
      modelKey: model.modelKey,
      usage: { totalTokens: 8 }
    });
    const checkpoint = await app.inject({
      method: "GET", url: `/api/conversations/${started.conversation.id}/context/compact`
    });
    expect(checkpoint.statusCode).toBe(200);
    expect(checkpoint.json()).toMatchObject({ conversationId: started.conversation.id, throughOrdinal: 2, text: "较早对话摘要" });
    expect(checkpoint.json()).not.toHaveProperty("sourceFingerprint");
  });

  it("executes an automatic tool and continues the same generation", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let requestIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestIndex += 1;
      return requestIndex === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_time", function: { name: "get_time_info", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }])
        : sse([{ choices: [{ delta: { content: "现在知道时间了" }, finish_reason: "stop" }] }]);
    }));
    const app = await testApp();
    const model = await createApiModel(app);
    const started = (await app.inject({
      method: "POST", url: "/api/conversations/start", payload: agentStartPayload(app, model.id, { text: "现在几点" })
    })).json();
    const generation = await waitForGeneration(app, started.generation.generationId);
    expect(generation.status).toBe("completed");
    expect(generation.toolCalls).toEqual([expect.objectContaining({
      id: "call_time", name: "get_time_info", approvalState: "completed", requiresApproval: false
    })]);
    expect(generation.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ content: "现在知道时间了" })]));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_time" })
    ]));
    await app.close();
  });

  it("pauses a write tool for approval and resumes after approval", async () => {
    let requestIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestIndex += 1;
      return requestIndex === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_write", function: { name: "workspace_write_file", arguments: "{\"path\":\"/workspace/note.txt\",\"text\":\"hello\"}" } }] }, finish_reason: "tool_calls" }] }])
        : sse([{ choices: [{ delta: { content: "文件已写入" }, finish_reason: "stop" }] }]);
    }));
    const app = await testApp();
    const model = await createApiModel(app);
    const started = (await app.inject({
      method: "POST", url: "/api/conversations/start", payload: agentStartPayload(app, model.id, {
        text: "写文件", workspacePath: join(app.store.dataDir, "workspace")
      })
    })).json();
    const waiting = await waitForStatus(app, started.generation.generationId, "waiting-approval");
    expect(waiting.toolCalls[0]).toMatchObject({ id: "call_write", approvalState: "pending", requiresApproval: true });
    const busy = await app.inject({
      method: "POST", url: `/api/conversations/${started.conversation.id}/messages`, payload: { text: "不能插队" }
    });
    expect(busy.statusCode).toBe(400);
    const approval = await app.inject({
      method: "POST", url: "/api/tool-calls/call_write/approval", payload: { approved: true }
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().resumed).toBe(true);
    const generation = await waitForGeneration(app, started.generation.generationId);
    expect(generation.toolCalls[0]).toMatchObject({ approvalState: "completed", output: expect.stringContaining("note.txt") });
    expect(generation.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ content: "文件已写入" })]));
    await app.close();
  });

  it("maps validation, StoreError, ProviderError, and unexpected errors", async () => {
    const app = await testApp();
    const invalid = await app.inject({ method: "POST", url: "/api/connections", payload: { name: "" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "validation_error", message: "请求参数无效", details: expect.any(Object) } });

    const missing = await app.inject({ method: "GET", url: "/api/conversations/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "conversation_not_found" } });

    const connection = (await app.inject({ method: "POST", url: "/api/connections", payload: {
      name: "Rejected", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "bad", secretHeaders: {}
    } })).json();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad credentials" } }), {
      status: 401, headers: { "content-type": "application/json" }
    })));
    const provider = await app.inject({ method: "POST", url: `/api/connections/${connection.id}/test` });
    expect(provider.statusCode).toBe(401);
    expect(provider.json()).toEqual({ error: { code: "provider_auth_error", message: "bad credentials" } });

    vi.spyOn(app.store, "listMemories").mockImplementation(() => { throw new Error("database exploded"); });
    const internal = await app.inject({ method: "GET", url: "/api/memories" });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toEqual({ error: { code: "internal_error", message: "服务端发生错误" } });
  });

  it("rescans the injected Agent Skills root", async () => {
    const app = await testApp();
    const source = join(app.store.dataDir, "agent-skills", "api-helper");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), [
      "---", "name: api-helper", "description: Discovered through the API", "compatibility: Linux", "---", "Instructions"
    ].join("\n"));

    const response = await app.inject({ method: "POST", url: "/api/skills/discover" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ discovered: 1, updated: 0, unchanged: 0, unloaded: 0, errors: [] });
    expect((await app.inject({ method: "GET", url: "/api/skills" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agents.api-helper", sourceKind: "agents", compatibility: "Linux" })
    ]));
  });

  it("returns 404 for stale assets while preserving the SPA route fallback", async () => {
    const runtimeAssetName = "runtime-added-12345678.js";
    const app = await testApp();
    const runtimeAssetPath = join(app.webRoot, "assets", runtimeAssetName);
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.headers["cache-control"]).toBe("no-cache");
    const scriptPath = index.body.match(/src="([^"]+\.js)"/)?.[1];
    expect(scriptPath).toBeTruthy();
    const currentAsset = await app.inject({ method: "GET", url: scriptPath! });
    expect(currentAsset.statusCode).toBe(200);
    expect(currentAsset.headers["content-type"]).toContain("application/javascript");
    expect(currentAsset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    writeFileSync(runtimeAssetPath, "export const loadedAfterStartup = true;\n");
    try {
      const runtimeAsset = await app.inject({ method: "GET", url: `/assets/${runtimeAssetName}` });
      expect(runtimeAsset.statusCode).toBe(200);
      expect(runtimeAsset.headers["content-type"]).toContain("application/javascript");
      expect(runtimeAsset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    } finally {
      rmSync(runtimeAssetPath, { force: true });
    }
    const asset = await app.inject({ method: "GET", url: "/assets/index-stale.js" });
    expect(asset.statusCode).toBe(404);
    expect(asset.headers["content-type"]).toContain("text/plain");
    expect(asset.body).toBe("Asset not found");
    const route = await app.inject({ method: "GET", url: "/c/00000000-0000-4000-8000-000000000000" });
    expect(route.statusCode).toBe(200);
    expect(route.headers["content-type"]).toContain("text/html");
    expect(route.headers["cache-control"]).toBe("no-cache");
  });

  it("covers MCP CRUD, conflicts, invalidation, and test routes without network access", async () => {
    const app = await testApp();
    const manager = mcpManager(app.store);
    const invalidate = vi.spyOn(manager, "invalidate");
    const test = vi.spyOn(manager, "test").mockResolvedValue({ ok: true, tools: 3, serverName: "Fake MCP" });

    const invalid = await app.inject({ method: "POST", url: "/api/mcp/servers", payload: {
      name: "bad name", url: "not a URL", headers: {}, enabled: true
    } });
    expect(invalid.statusCode).toBe(400);

    const firstResponse = await app.inject({ method: "POST", url: "/api/mcp/servers", payload: {
      name: "Alpha", url: "https://alpha.example/mcp", headers: { Authorization: "secret" }, enabled: true
    } });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json();
    expect(first).toMatchObject({ name: "Alpha", headerNames: ["Authorization"], enabled: true, lastError: null });
    expect(firstResponse.body).not.toContain("secret");
    const second = (await app.inject({ method: "POST", url: "/api/mcp/servers", payload: {
      name: "Beta", url: "https://beta.example/mcp", headers: {}, enabled: false
    } })).json();

    const duplicateCreate = await app.inject({ method: "POST", url: "/api/mcp/servers", payload: {
      name: "Alpha", url: "https://other.example/mcp", headers: {}, enabled: true
    } });
    expect(duplicateCreate.statusCode).toBe(400);
    expect(duplicateCreate.json()).toMatchObject({ error: { code: "mcp_name_conflict" } });
    const duplicatePatch = await app.inject({ method: "PATCH", url: `/api/mcp/servers/${second.id}`, payload: { name: "Alpha" } });
    expect(duplicatePatch.statusCode).toBe(400);

    const renamed = await app.inject({ method: "PATCH", url: `/api/mcp/servers/${first.id}`, payload: { name: "Alpha2" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Alpha2", headerNames: ["Authorization"], enabled: true });
    const updated = await app.inject({ method: "PATCH", url: `/api/mcp/servers/${first.id}`, payload: { enabled: false } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Alpha2", headerNames: ["Authorization"], enabled: false });
    expect(app.store.getMcpServer(first.id)).toMatchObject({
      name: "Alpha2", url: "https://alpha.example/mcp", headers: { Authorization: "secret" }, enabled: false
    });
    const cleared = await app.inject({ method: "PATCH", url: `/api/mcp/servers/${first.id}`, payload: { headers: {} } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ headerNames: [], enabled: false });
    expect(invalidate).toHaveBeenCalledWith(first.id);
    expect((await app.inject({ method: "PATCH", url: "/api/mcp/servers/missing", payload: { enabled: true } })).statusCode).toBe(404);

    const tested = await app.inject({ method: "POST", url: `/api/mcp/servers/${first.id}/test` });
    expect(tested.json()).toEqual({ ok: true, tools: 3, serverName: "Fake MCP" });
    expect(test).toHaveBeenCalledWith(first.id);
    expect((await app.inject({ method: "POST", url: "/api/mcp/servers/missing/test" })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/mcp/servers/${first.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/mcp/servers/${first.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/mcp/servers" })).json()).toEqual([expect.objectContaining({ id: second.id })]);
  });

  it("sends an SSE snapshot before events buffered during subscription and closes terminal streams", async () => {
    const app = await testApp();
    const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "SSE", modelId: model.id, contextPolicy: "full" });
    const generationId = started.generation.generationId;
    app.store.finishGeneration(generationId, "completed", { stopReason: "stop" });
    const unsubscribe = vi.fn();
    vi.spyOn(app.runner, "subscribe").mockImplementation((_id, subscriber) => {
      subscriber({
        type: "block-delta",
        generationId,
        block: { id: `${generationId}:0`, index: 0, stepIndex: 0, type: "text", content: "buffered", complete: true }
      });
      return unsubscribe;
    });

    const response = await app.inject({ method: "GET", url: `/api/generations/${generationId}/events` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body.indexOf("event: snapshot")).toBeLessThan(response.body.indexOf("event: block-delta"));
    expect(response.body).toContain('"status":"completed"');
    expect(response.body).toContain('"content":"buffered"');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("covers cancellation and approval endpoint guards and transitions", async () => {
    const app = await testApp();
    const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "approve", modelId: model.id, contextPolicy: "full" });
    const generationId = started.generation.generationId;

    expect((await app.inject({ method: "POST", url: "/api/generations/missing/cancel" })).statusCode).toBe(404);
    const cancel = vi.spyOn(app.runner, "cancel").mockReturnValue(true);
    expect((await app.inject({ method: "POST", url: `/api/generations/${generationId}/cancel` })).json()).toEqual({ ok: true, status: "stopping" });
    expect(cancel).toHaveBeenCalledWith(generationId);

    expect((await app.inject({ method: "POST", url: "/api/tool-calls/missing/approval", payload: { approved: true } })).statusCode).toBe(404);
    app.store.upsertToolCall(generationId, { id: "not-waiting", name: "write", arguments: "{}" }, 0, 0, true);
    expect((await app.inject({ method: "POST", url: "/api/tool-calls/not-waiting/approval", payload: { approved: true } })).json())
      .toMatchObject({ error: { code: "generation_not_waiting" } });

    app.store.setGenerationWaitingApproval(generationId);
    app.store.upsertToolCall(generationId, { id: "pending-two", name: "write", arguments: "{}" }, 1, 0, true);
    const start = vi.spyOn(app.runner, "start").mockImplementation(() => {});
    const first = await app.inject({ method: "POST", url: "/api/tool-calls/not-waiting/approval", payload: { approved: true } });
    expect(first.json()).toMatchObject({ resumed: false, toolCall: { approvalState: "approved" } });
    expect(start).not.toHaveBeenCalled();
    const denied = await app.inject({
      method: "POST", url: "/api/tool-calls/pending-two/approval", payload: { approved: false, reason: "unsafe" }
    });
    expect(denied.json()).toMatchObject({ resumed: true, toolCall: { approvalState: "denied", output: expect.stringContaining("unsafe") } });
    expect(start).toHaveBeenCalledWith(generationId);
    const repeated = await app.inject({ method: "POST", url: "/api/tool-calls/pending-two/approval", payload: { approved: true } });
    expect(repeated.json()).toMatchObject({ error: { code: "tool_call_not_pending" } });
    expect((await app.inject({ method: "POST", url: "/api/tool-calls/not-waiting/approval", payload: {} })).statusCode).toBe(400);
  });

  it("supports Agent CRUD, avatars, and Character Card import/export", async () => {
    const app = await testApp();
    const listed = (await app.inject({ method: "GET", url: "/api/agents" })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "默认助手", protected: true });
    const base = (await app.inject({ method: "GET", url: `/api/agents/${listed[0].id}` })).json();
    const createdResponse = await app.inject({ method: "POST", url: "/api/agents", payload: {
      card: { ...base.card, data: { ...base.card.data, name: "Mira" } },
      execution: base.execution,
      userProfile: { displayName: "Lin" }
    } });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({ roleplay: { enabled: false }, roleplayEnabled: false });
    const updated = (await app.inject({ method: "PATCH", url: `/api/agents/${created.id}`, payload: {
      userProfile: { displayName: "Lee" }
    } })).json();
    expect(updated).toMatchObject({ revision: 2, userProfile: { displayName: "Lee" } });
    const searchConfigured = await app.inject({
      method: "PATCH", url: `/api/agents/${created.id}`,
      payload: { execution: { ...updated.execution, search: { provider: "tavily", baseUrl: "" } } }
    });
    expect(searchConfigured.statusCode).toBe(200);
    const searchSecret = await app.inject({
      method: "PATCH", url: `/api/agents/${created.id}/search-secret`,
      payload: { provider: "tavily", apiKey: "tvly-test-secret" }
    });
    expect(searchSecret.json()).toEqual({ provider: "tavily", hasApiKey: true });
    expect(JSON.stringify((await app.inject({ method: "GET", url: `/api/agents/${created.id}` })).json()))
      .not.toContain("tvly-test-secret");
    expect((await app.inject({ method: "GET", url: `/api/tools/catalog?agentId=${created.id}` })).json())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "search_web", available: true })]));

    const presetImport = await app.inject({
      method: "POST",
      url: `/api/agents/${created.id}/roleplay/presets/import`,
      payload: {
        fileName: "story.json",
        dataBase64: Buffer.from(JSON.stringify({
          name: "Story preset",
          prompts: [{ identifier: "chatHistory", name: "History", role: "system", content: "" }]
        })).toString("base64")
      }
    });
    expect(presetImport.statusCode).toBe(201);
    expect(presetImport.json().roleplay.presets.at(-1)).toMatchObject({
      name: "Story preset",
      importedFrom: "sillytavern"
    });
    const conversation = (await app.inject({
      method: "POST", url: "/api/conversations", payload: { agentId: created.id }
    })).json();
    const initialRoleplay = (await app.inject({
      method: "GET", url: `/api/conversations/${conversation.id}/roleplay-state`
    })).json();
    const changedRoleplay = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}/roleplay-state`,
      payload: { authorNote: "Use a quiet tone", variables: { chapter: 3 } }
    });
    expect(changedRoleplay.json()).toEqual(expect.objectContaining({
      ...initialRoleplay,
      authorNote: "Use a quiet tone",
      variables: { chapter: 3 }
    }));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const configured = app.store.getAgent(created.id)!;
    app.store.updateAgent(created.id, { roleplay: { ...configured.roleplay, enabled: true } });
    const script = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/roleplay-scripts/execute`,
      payload: { script: "/setvar chapter 4 | /input \"continue\"", draft: "" }
    });
    expect(script.statusCode).toBe(200);
    expect(script.json()).toMatchObject({ draft: "continue", state: { variables: { chapter: 4 } }, commands: 2 });
    const audit = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/roleplay-scripts/audit` });
    expect(audit.json()[0]).toMatchObject({ sourceKind: "inline", success: true, commandCount: 2 });

    const roleplayAsset = await app.inject({
      method: "POST", url: `/api/agents/${created.id}/roleplay/assets`,
      payload: { fileName: "scene.png", mimeType: "image/png", type: "background", dataBase64: png }
    });
    expect(roleplayAsset.statusCode).toBe(201);
    expect(roleplayAsset.json().roleplay.assets[0]).toMatchObject({ type: "background", name: "scene.png" });

    expect((await app.inject({ method: "PUT", url: `/api/agents/${created.id}/avatar`, payload: {
      fileName: "avatar.png", dataBase64: png
    } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/agents/${created.id}/avatar` })).headers["content-type"]).toContain("image/png");
    const exported = await app.inject({ method: "GET", url: `/api/agents/${created.id}/export?format=json` });
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(JSON.parse(exported.body).data.extensions.llm_chat).toMatchObject({ version: 1 });
    const charx = await app.inject({ method: "GET", url: `/api/agents/${created.id}/export?format=charx` });
    expect(charx.statusCode).toBe(200);
    expect(charx.headers["content-type"]).toContain("application/vnd.character-card+zip");

    const imported = await app.inject({ method: "POST", url: "/api/agents/import", payload: {
      fileName: "mira.json", dataBase64: Buffer.from(exported.body).toString("base64")
    } });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().name).toBe("Mira (2)");
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${created.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${base.id}` })).json()).toMatchObject({ error: { code: "agent_protected" } });
    await app.close();
  });

  it("returns not-found and busy errors across connection, model, conversation, and generation routes", async () => {
    const app = await testApp();
    for (const [method, url, payload] of [
      ["PATCH", "/api/connections/missing", { name: "x" }],
      ["DELETE", "/api/connections/missing", undefined],
      ["POST", "/api/connections/missing/test", undefined],
      ["POST", "/api/connections/missing/models/discover", undefined],
      ["PATCH", "/api/models/missing", { displayName: "x" }],
      ["DELETE", "/api/models/missing", undefined],
      ["GET", "/api/conversations/missing", undefined],
      ["PATCH", "/api/conversations/missing", { title: "x" }],
      ["DELETE", "/api/conversations/missing", undefined],
      ["GET", "/api/conversations/missing/messages", undefined],
      ["POST", "/api/conversations/missing/messages", { text: "x" }],
      ["GET", "/api/generations/missing", undefined],
      ["GET", "/api/generations/missing/events", undefined]
    ] as const) {
      const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const missingConnection = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: modelPayload("00000000-0000-4000-8000-000000000000")
    });
    expect(missingConnection.json()).toMatchObject({ error: { code: "connection_not_found" } });
    expect((await app.inject({ method: "POST", url: "/api/messages/missing/generations", payload: {} })).json())
      .toMatchObject({ error: { code: "message_not_found" } });
    expect((await app.inject({
      method: "PATCH", url: "/api/messages/missing/active-generation", payload: { generationId: "00000000-0000-4000-8000-000000000000" }
    })).json()).toMatchObject({ error: { code: "generation_not_found" } });

    const model = await createApiModel(app);
    const started = app.store.startConversation({ text: "busy", modelId: model.id, contextPolicy: "full" });
    const conversationId = started.conversation.id;
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${conversationId}` })).json())
      .toMatchObject({ error: { code: "conversation_busy" } });
    expect((await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: { text: "blocked" } })).json())
      .toMatchObject({ error: { code: "conversation_busy" } });
  });
});

function agentStartPayload(
  app: Awaited<ReturnType<typeof testApp>>,
  modelId: string,
  options: { text: string; contextPolicy?: "auto" | "trim" | "summarize" | "full"; reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"; workspacePath?: string | null }
) {
  return {
    text: options.text,
    agentId: app.store.getSettings().defaultAgentId,
    greetingIndex: 0,
    workspacePath: options.workspacePath ?? null,
    executionOverrides: {
      modelId,
      ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
    }
  };
}

async function waitForGeneration(app: Awaited<ReturnType<typeof testApp>>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/generations/${id}` });
    const generation = response.json();
    if (["completed", "stopped", "failed", "interrupted"].includes(generation.status)) return generation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`generation ${id} did not finish in time`);
}

async function waitForStatus(app: Awaited<ReturnType<typeof testApp>>, id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/generations/${id}` });
    const generation = response.json();
    if (generation.status === status) return generation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`generation ${id} did not reach ${status}`);
}

async function createApiModel(app: Awaited<ReturnType<typeof testApp>>) {
  const connection = (await app.inject({ method: "POST", url: "/api/connections", payload: {
    name: "Tool Mock", protocol: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key", secretHeaders: {}
  } })).json();
  return (await app.inject({ method: "POST", url: "/api/models", payload: {
    connectionId: connection.id,
    modelKey: "tool-model",
    displayName: "Tool Model",
    contextWindow: 65536,
    maxOutputTokens: 256,
    capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
    defaultSettings: { common: { maxOutputTokens: 256, stopSequences: [] }, protocol: {} },
    enabled: true
  } })).json();
}

function testWebRoot(dir: string): string {
  const root = join(dir, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<html><script src="/assets/index-12345678.js"></script></html>');
  writeFileSync(join(root, "assets/index-12345678.js"), "export const app = true;");
  writeFileSync(join(root, "render-frame.html"), "<html></html>");
  return root;
}

async function testApp() {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-api-"));
  dirs.push(dir);
  const webRoot = testWebRoot(dir);
  let password = "";
  const app = await buildApp({
    dataFile: join(dir, "test.sqlite"), logger: false, webRoot,
    authAnnounce: (message) => { password = message.match(/\d{8}/)![0]; },
    skillDiscoveryRoot: join(dir, "agent-skills")
  });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-llm-chat-request": "1" }, payload: { password } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  return {
    store: app.store, runner: app.runner, webRoot, password, close: () => app.close(),
    inject: (options: InjectOptions) => app.inject({ ...options, headers: { cookie, "x-llm-chat-request": "1", ...options.headers } })
  };
}

function modelPayload(connectionId: string): ModelInput {
  return {
    connectionId,
    modelKey: "route-model",
    displayName: "Route Model",
    contextWindow: 4096,
    maxOutputTokens: 256,
    capabilities: { imageInput: false, tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
    defaultSettings: { common: { maxOutputTokens: 256, stopSequences: [] }, protocol: {} },
    enabled: true
  };
}

function sse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
