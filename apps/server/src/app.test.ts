import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, ModelSettings } from "@llm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
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
      contextWindow: 2048,
      maxOutputTokens: 128,
      capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
      defaultSettings: settings,
      enabled: true
    };
    const model = (await app.inject({ method: "POST", url: "/api/models", payload: modelInput })).json();
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { defaultModelId: model.id, defaultSystemPrompt: "系统提示", reasoningEffort: "low" } });
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

  it("returns 404 for stale assets while preserving the SPA route fallback", async () => {
    const app = await testApp(true);
    const asset = await app.inject({ method: "GET", url: "/assets/index-stale.js" });
    expect(asset.statusCode).toBe(404);
    expect(asset.headers["content-type"]).toContain("text/plain");
    expect(asset.body).toBe("Asset not found");
    const route = await app.inject({ method: "GET", url: "/c/00000000-0000-4000-8000-000000000000" });
    expect(route.statusCode).toBe(200);
    expect(route.headers["content-type"]).toContain("text/html");
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

    const updated = await app.inject({ method: "PATCH", url: `/api/mcp/servers/${first.id}`, payload: { enabled: false } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: false });
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
        block: { id: `${generationId}:0`, index: 0, type: "text", content: "buffered", complete: true }
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
    expect((await app.inject({ method: "POST", url: `/api/generations/${generationId}/cancel` })).json()).toEqual({ ok: true });
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
    const updated = (await app.inject({ method: "PATCH", url: `/api/agents/${created.id}`, payload: {
      userProfile: { displayName: "Lee" }
    } })).json();
    expect(updated).toMatchObject({ revision: 2, userProfile: { displayName: "Lee" } });

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect((await app.inject({ method: "PUT", url: `/api/agents/${created.id}/avatar`, payload: {
      fileName: "avatar.png", dataBase64: png
    } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/agents/${created.id}/avatar` })).headers["content-type"]).toContain("image/png");
    const exported = await app.inject({ method: "GET", url: `/api/agents/${created.id}/export?format=json` });
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(JSON.parse(exported.body).data.extensions.llm_chat).toMatchObject({ version: 1 });

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
  options: { text: string; contextPolicy?: "trim" | "summarize" | "full"; reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"; workspacePath?: string | null }
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
    contextWindow: 4096,
    maxOutputTokens: 256,
    capabilities: { tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
    defaultSettings: { common: { maxOutputTokens: 256, stopSequences: [] }, protocol: {} },
    enabled: true
  } })).json();
}

async function testApp(serveWeb = false) {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-api-"));
  dirs.push(dir);
  const app = await buildApp({ dataFile: join(dir, "test.sqlite"), logger: false, serveWeb });
  apps.push(app);
  return app;
}

function modelPayload(connectionId: string): ModelInput {
  return {
    connectionId,
    modelKey: "route-model",
    displayName: "Route Model",
    contextWindow: 4096,
    maxOutputTokens: 256,
    capabilities: { tools: true, temperature: true, topP: true, reasoning: false, reasoningSummary: false, adaptiveThinking: false, manualThinking: false },
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
