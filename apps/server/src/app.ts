import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import {
  appSettingsSchema,
  connectionInputSchema,
  conversationInputSchema,
  mcpServerInputSchema,
  modelInputSchema,
  patchConversationSchema,
  retryGenerationSchema,
  sendMessageSchema,
  startConversationSchema,
  toolApprovalInputSchema,
  toolSettingsInputSchema,
  type GenerationEvent
} from "@llm-chat/contracts";
import { adapterFor, ProviderError } from "@llm-chat/providers";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { Store, StoreError } from "./database";
import { GenerationRunner } from "./generations";
import { closeMcpManager, mcpManager } from "./mcp";
import { toolCatalog } from "./tools";

export interface AppOptions {
  dataFile: string;
  logger?: boolean;
  serveWeb?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 });
  const store = new Store(options.dataFile);
  const runner = new GenerationRunner(store);
  app.decorate("store", store);
  app.decorate("runner", runner);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "validation_error", message: "请求参数无效", details: z.treeifyError(error) }
      });
    }
    if (error instanceof StoreError) {
      const status = error.code.endsWith("not_found") ? 404 : 400;
      return reply.code(status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ProviderError) {
      return reply.code(error.status && error.status < 500 ? error.status : 502).send({
        error: { code: error.code, message: error.message }
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "internal_error", message: "服务端发生错误" } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/settings", async () => store.getSettings());
  app.patch("/api/settings", async (request) => {
    const patch = appSettingsSchema.partial().parse(request.body);
    if (patch.defaultModelId) {
      const model = store.getModel(patch.defaultModelId);
      if (!model) throw new StoreError("model_not_found", "默认模型不存在");
      if (!model.enabled) throw new StoreError("model_disabled", "默认模型已停用");
    }
    return store.updateSettings(patch);
  });
  app.get("/api/tools/settings", async () => store.getToolSettings());
  app.patch("/api/tools/settings", async (request) => store.updateToolSettings(toolSettingsInputSchema.parse(request.body)));
  app.get("/api/tools/catalog", async () => toolCatalog(store));
  app.get("/api/memories", async () => store.listMemories());
  app.get("/api/mcp/servers", async () => store.listMcpServers());
  app.post("/api/mcp/servers", async (request, reply) => {
    const value = mcpServerInputSchema.parse(request.body);
    if (store.listMcpServers().some((item) => item.name === value.name)) throw new StoreError("mcp_name_conflict", "MCP 名称已存在");
    return reply.code(201).send(store.createMcpServer(value));
  });
  app.patch<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request) => {
    const value = mcpServerInputSchema.partial().parse(request.body);
    const duplicate = value.name && store.listMcpServers().some((item) => item.name === value.name && item.id !== request.params.id);
    if (duplicate) throw new StoreError("mcp_name_conflict", "MCP 名称已存在");
    const result = store.updateMcpServer(request.params.id, value);
    if (!result) throw new StoreError("mcp_server_not_found", "MCP 服务不存在");
    mcpManager(store).invalidate(request.params.id);
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request, reply) => {
    mcpManager(store).invalidate(request.params.id);
    if (!store.deleteMcpServer(request.params.id)) throw new StoreError("mcp_server_not_found", "MCP 服务不存在");
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/test", async (request) => {
    if (!store.getMcpServer(request.params.id)) throw new StoreError("mcp_server_not_found", "MCP 服务不存在");
    return mcpManager(store).test(request.params.id);
  });

  app.get("/api/connections", async () => store.listConnections());
  app.post("/api/connections", async (request, reply) => {
    const value = connectionInputSchema.parse(request.body);
    return reply.code(201).send(store.createConnection(value));
  });
  app.patch<{ Params: { id: string } }>("/api/connections/:id", async (request) => {
    const value = connectionInputSchema.partial().parse(request.body);
    const result = store.updateConnection(request.params.id, value);
    if (!result) throw new StoreError("connection_not_found", "连接不存在");
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    if (!store.deleteConnection(request.params.id)) throw new StoreError("connection_not_found", "连接不存在");
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", async (request) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) throw new StoreError("connection_not_found", "连接不存在");
    const models = await adapterFor(connection.protocol).listModels(connection, AbortSignal.timeout(15_000));
    return { ok: true, modelsFound: models.length };
  });
  app.post<{ Params: { id: string } }>("/api/connections/:id/models/discover", async (request) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) throw new StoreError("connection_not_found", "连接不存在");
    const discovered = await adapterFor(connection.protocol).listModels(connection, AbortSignal.timeout(15_000));
    const existing = new Set(store.listModels(connection.id).map((model) => model.modelKey));
    const created = discovered
      .filter((model) => !existing.has(model.id))
      .map((model) => store.createModel(defaultModel(connection.id, connection.protocol, model.id, model.displayName), "discovered"));
    return { discovered: discovered.length, created };
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/models", async (request) => {
    return store.listModels(request.query.connectionId);
  });
  app.post("/api/models", async (request, reply) => {
    const value = modelInputSchema.parse(request.body);
    if (!store.getConnection(value.connectionId)) throw new StoreError("connection_not_found", "连接不存在");
    return reply.code(201).send(store.createModel(value));
  });
  app.patch<{ Params: { id: string } }>("/api/models/:id", async (request) => {
    const value = modelInputSchema.partial().parse(request.body);
    const result = store.updateModel(request.params.id, value);
    if (!result) throw new StoreError("model_not_found", "模型不存在");
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    if (!store.deleteModel(request.params.id)) throw new StoreError("model_not_found", "模型不存在");
    return reply.code(204).send();
  });

  app.get("/api/conversations", async () => store.listConversations());
  app.post("/api/conversations", async (request, reply) => {
    const value = conversationInputSchema.parse(request.body ?? {});
    return reply.code(201).send(store.createConversation(value));
  });
  app.post("/api/conversations/start", async (request, reply) => {
    const value = startConversationSchema.parse(request.body);
    const result = store.startConversation(value);
    runner.start(result.generation.generationId);
    return reply.code(202).send(result);
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
    return conversation;
  });
  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const value = patchConversationSchema.parse(request.body);
    const result = store.updateConversation(request.params.id, value);
    if (!result) throw new StoreError("conversation_not_found", "会话不存在");
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    if (store.isConversationBusy(request.params.id)) {
      throw new StoreError("conversation_busy", "请先停止当前生成，再删除会话");
    }
    if (!store.deleteConversation(request.params.id)) throw new StoreError("conversation_not_found", "会话不存在");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request) => {
    if (!store.getConversation(request.params.id)) throw new StoreError("conversation_not_found", "会话不存在");
    return store.listMessages(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    if (store.isConversationBusy(request.params.id)) throw new StoreError("conversation_busy", "该会话还有生成或工具审批未完成");
    const value = sendMessageSchema.parse(request.body);
    const result = store.createMessageGeneration(request.params.id, value.text);
    runner.start(result.generationId);
    return reply.code(202).send(result);
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/generations", async (request, reply) => {
    retryGenerationSchema.parse(request.body ?? {});
    const conversationId = store.conversationIdForMessage(request.params.id);
    if (!conversationId) throw new StoreError("message_not_found", "助手消息不存在");
    if (store.isConversationBusy(conversationId)) throw new StoreError("conversation_busy", "该会话还有生成或工具审批未完成");
    const result = store.createRetryGeneration(request.params.id);
    runner.start(result.generationId);
    return reply.code(202).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/messages/:id/active-generation", async (request) => {
    const value = z.object({ generationId: z.string().uuid() }).parse(request.body);
    if (!store.selectGeneration(request.params.id, value.generationId)) {
      throw new StoreError("generation_not_found", "生成版本不存在");
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/generations/:id", async (request) => {
    const generation = store.getGeneration(request.params.id);
    if (!generation) throw new StoreError("generation_not_found", "生成不存在");
    return generation;
  });
  app.get<{ Params: { id: string } }>("/api/generations/:id/events", async (request, reply) => {
    if (!store.getGeneration(request.params.id)) throw new StoreError("generation_not_found", "生成不存在");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const send = (event: GenerationEvent) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const buffered: GenerationEvent[] = [];
    let snapshotSent = false;
    const unsubscribe = runner.subscribe(request.params.id, (event) => {
      if (!snapshotSent) {
        buffered.push(event);
        return;
      }
      send(event);
      if (event.type === "status" && isStreamEnd(event.status)) reply.raw.end();
    });
    const generation = store.getGeneration(request.params.id)!;
    send({ type: "snapshot", generation });
    snapshotSent = true;
    for (const event of buffered) send(event);
    if (isStreamEnd(generation.status)) {
      unsubscribe();
      reply.raw.end();
      return;
    }
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.post<{ Params: { id: string } }>("/api/generations/:id/cancel", async (request) => {
    const generation = store.getGeneration(request.params.id);
    if (!generation) throw new StoreError("generation_not_found", "生成不存在");
    return { ok: runner.cancel(request.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/tool-calls/:id/approval", async (request) => {
    const value = toolApprovalInputSchema.parse(request.body);
    const call = store.getToolCall(request.params.id);
    if (!call) throw new StoreError("tool_call_not_found", "工具调用不存在");
    if (call.approvalState !== "pending") throw new StoreError("tool_call_not_pending", "工具调用已处理");
    const generationId = store.generationIdForToolCall(call.id)!;
    const generation = store.getGeneration(generationId);
    if (generation?.status !== "waiting-approval") throw new StoreError("generation_not_waiting", "生成当前不在等待审批");
    const updated = value.approved
      ? store.updateToolCall(call.id, { approvalState: "approved" })!
      : store.updateToolCall(call.id, {
          approvalState: "denied",
          output: JSON.stringify({ error: `Tool execution denied by user${value.reason ? `: ${value.reason}` : ""}` }),
          completedAt: Date.now()
        })!;
    const pending = store.listToolCalls(generationId).some((item) => item.approvalState === "pending");
    if (!pending) runner.start(generationId);
    return { toolCall: updated, generationId, resumed: !pending };
  });

  if (options.serveWeb !== false) await registerWeb(app);

  app.addHook("onClose", async () => {
    runner.stopAll();
    await closeMcpManager(store);
    store.close();
  });
  return app;
}

function defaultModel(connectionId: string, protocol: "openai-responses" | "openai-chat" | "anthropic-messages", modelKey: string, displayName: string) {
  const anthropic = protocol === "anthropic-messages";
  const responses = protocol === "openai-responses";
  return {
    connectionId,
    modelKey,
    displayName,
    contextWindow: null,
    maxOutputTokens: 4096,
    capabilities: {
      tools: true,
      temperature: true,
      topP: true,
      reasoning: responses || anthropic,
      reasoningSummary: responses,
      adaptiveThinking: anthropic,
      manualThinking: anthropic
    },
    defaultSettings: {
      common: { maxOutputTokens: 4096, stopSequences: [] },
      protocol: {}
    },
    enabled: true
  };
}

function isStreamEnd(status: string): boolean {
  return ["waiting-approval", "completed", "stopped", "failed", "interrupted"].includes(status);
}

async function registerWeb(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../web/dist");
  if (!existsSync(resolve(root, "index.html"))) return;
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "not_found", message: "API 不存在" } });
    }
    return reply.sendFile("index.html");
  });
}

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    runner: GenerationRunner;
  }
}
