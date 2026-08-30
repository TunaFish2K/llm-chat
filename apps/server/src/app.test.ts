import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, ModelSettings } from "@llm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
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
      payload: { text: "你好", modelId: model.id, contextPolicy: "summarize" }
    });
    expect(startResponse.statusCode).toBe(202);
    const started = startResponse.json();
    const conversation = started.conversation;
    expect(conversation).toMatchObject({
      title: "你好",
      modelId: model.id,
      systemPrompt: "系统提示",
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
    expect(messages[1].generatedModel).toMatchObject({ modelId: model.id, displayName: "Mock" });
    await app.close();
  });

  it("does not create a conversation when start validation fails", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/start",
      payload: {
        text: "你好",
        modelId: "00000000-0000-4000-8000-000000000000"
      }
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
      payload: { text: "你好", modelId: model.id }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "reasoning_not_supported" } });
    expect((await app.inject({ method: "GET", url: "/api/conversations" })).json()).toEqual([]);
    await app.close();
  });

  it("requires a conversation model before sending", async () => {
    const app = await testApp();
    const conversation = (await app.inject({ method: "POST", url: "/api/conversations", payload: { systemPrompt: "" } })).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "你好" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "conversation_model_required" } });
    await app.close();
  });

  it("uses the global reasoning effort for start, send, and retry", async () => {
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
      method: "POST", url: "/api/conversations/start", payload: { text: "你好", modelId: model.id }
    })).json();
    const conversationId = started.conversation.id as string;
    let generation = await waitForGeneration(app, started.generation.generationId);
    expect(generation.settings.reasoningEffort).toBe("medium");

    await app.inject({ method: "PATCH", url: "/api/settings", payload: { reasoningEffort: "xhigh" } });
    const sendResponse = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "第二条" }
    });
    expect(sendResponse.statusCode).toBe(202);
    const message = sendResponse.json();
    generation = await waitForGeneration(app, message.generationId);
    expect(generation.settings.reasoningEffort).toBe("xhigh");

    await app.inject({ method: "PATCH", url: "/api/settings", payload: { reasoningEffort: "max" } });
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
      method: "POST", url: "/api/conversations/start", payload: { text: "现在几点", modelId: model.id }
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
      method: "POST", url: "/api/conversations/start", payload: { text: "写文件", modelId: model.id }
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
});

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

async function testApp() {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-api-"));
  dirs.push(dir);
  return buildApp({ dataFile: join(dir, "test.sqlite"), logger: false, serveWeb: false });
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
