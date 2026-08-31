import { existsSync } from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  appSettingsSchema,
  agentInputSchema,
  connectionInputSchema,
  conversationInputSchema,
  encodedFileSchema,
  mcpServerInputSchema,
  mcpServerPatchSchema,
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
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { Store, StoreError } from "./database";
import { exportCharacterCard, importCharacterCard } from "./character-card";
import { GenerationRunner } from "./generations";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { closeMcpManager, mcpManager } from "./mcp";
import { PluginManager } from "./plugins";
import { SkillManager } from "./skills";
import { ToolRegistry } from "./tool-registry";
import { canonicalWorkspace, createDirectory, listDirectories } from "./workspaces";
import { BalanceError, BalanceService } from "./balance";
import { AuthError, AuthManager, type AuthIdentity } from "./auth";

export type AuthMode = "webauthn" | "disabled";

export interface AppOptions {
  dataFile: string;
  logger?: boolean;
  serveWeb?: boolean;
  skillDiscoveryRoot?: string;
  authMode?: AuthMode;
  trustProxy?: boolean | string;
  publicUrl?: string;
  rpId?: string;
  authAnnounce?: (message: string) => void;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 15 * 1024 * 1024,
    trustProxy: options.trustProxy ?? false
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyCompress, { global: true });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null
      }
    }
  });
  const store = new Store(options.dataFile);
  const authMode = options.authMode ?? "disabled";
  const publicOrigin = new URL(options.publicUrl ?? "http://localhost").origin;
  const auth = new AuthManager(store, {
    origin: publicOrigin,
    rpId: options.rpId ?? new URL(publicOrigin).hostname
  }, options.authAnnounce ?? ((message) => {
    if (options.logger !== false) process.stderr.write(`\n${message}\n`);
  }));
  if (authMode === "webauthn") await auth.ensureBootstrapRequest();
  const balanceService = new BalanceService();
  const eventHub = new EventHub();
  const taskManager = new TaskManager(store, eventHub);
  const pluginManager = new PluginManager(store, eventHub);
  const skillManager = new SkillManager(store, eventHub,
    options.skillDiscoveryRoot === undefined ? {} : { discoveryRoot: options.skillDiscoveryRoot });
  await skillManager.initialize();
  const registry = new ToolRegistry(store, taskManager, pluginManager, skillManager);
  const runner = new GenerationRunner(store, {
    buildTools: (_currentStore, record) => registry.tools(record),
    runtimePrompt: (_currentStore, record) => taskManager.runtimePrompt(record.conversationId)
  });
  app.decorate("store", store);
  app.decorate("runner", runner);
  app.decorateRequest("authIdentity", null);

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
    if (error instanceof BalanceError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof AuthError || error instanceof AuthHttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
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

  app.addHook("preHandler", async (request, reply) => {
    if (authMode !== "webauthn" || !request.url.startsWith("/api/")) return;
    requireSafeTransport(request);
    if (!isReadMethod(request.method)) requireMutationSource(request, publicOrigin);
    if (isPublicApiRoute(request)) return;
    const token = sessionToken(request);
    const identity = auth.authenticate(token);
    if (!identity) {
      await auth.ensureBootstrapRequest();
      return reply.code(401).send({ error: { code: "authentication_required", message: "请使用 Passkey 登录或扫描二维码添加此设备" } });
    }
    if (identity.refreshCookie) setSessionCookie(request, reply, token!);
    request.authIdentity = identity;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.post("/api/auth/bootstrap/options", authRateLimit(8), async (request) => {
    requireAuthEnabled(authMode);
    const value = bootstrapSecretSchema.parse(request.body);
    return auth.bootstrapOptions(value.requestId, value.secret);
  });
  app.post("/api/auth/bootstrap/verify", authRateLimit(8), async (request, reply) => {
    requireAuthEnabled(authMode);
    const value = bootstrapVerifySchema.parse(request.body);
    const result = await auth.verifyBootstrap({
      id: value.requestId,
      secret: value.secret,
      deviceName: value.deviceName,
      response: value.response as RegistrationResponseJSON
    });
    setSessionCookie(request, reply, result.token);
    return reply.code(201).send({ ok: true });
  });
  app.post("/api/auth/enrollments/options", authRateLimit(12), async (request, reply) => {
    requireAuthEnabled(authMode);
    const value = z.object({ deviceName: deviceNameSchema }).parse(request.body);
    return reply.code(201).send(await auth.beginEnrollment({
      deviceName: value.deviceName,
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? ""
    }));
  });
  app.post<{ Params: { id: string } }>("/api/auth/enrollments/:id/credential", authRateLimit(12), async (request) => {
    requireAuthEnabled(authMode);
    const value = enrollmentCredentialSchema.parse(request.body);
    return auth.finishEnrollment({
      id: request.params.id,
      tabSecret: value.tabSecret,
      approvalSecret: value.approvalSecret,
      response: value.response as RegistrationResponseJSON
    });
  });
  app.get<{ Params: { id: string } }>("/api/auth/enrollments/:id/status", authRateLimit(120), async (request, reply) => {
    requireAuthEnabled(authMode);
    const tabSecret = singleHeader(request.headers["x-llm-chat-enrollment"]);
    if (!tabSecret) throw new AuthError(401, "enrollment_secret_required", "缺少本机配对凭据");
    const result = auth.enrollmentStatus(request.params.id, tabSecret);
    if (result.state === "authenticated") {
      setSessionCookie(request, reply, result.token);
      return { state: "authenticated" };
    }
    return result;
  });
  app.get<{ Params: { id: string } }>("/api/auth/approvals/:id", authRateLimit(60), async (request) => {
    requireAuthEnabled(authMode);
    return auth.approvalDetails(request.params.id, requireApprovalSecret(request));
  });
  app.post<{ Params: { id: string } }>("/api/auth/approvals/:id/options", authRateLimit(12), async (request) => {
    requireAuthEnabled(authMode);
    return auth.approvalOptions(request.params.id, requireApprovalSecret(request));
  });
  app.post<{ Params: { id: string } }>("/api/auth/approvals/:id/verify", authRateLimit(12), async (request, reply) => {
    requireAuthEnabled(authMode);
    const response = webAuthnAuthenticationResponseSchema.parse(request.body) as AuthenticationResponseJSON;
    const result = await auth.approve({ id: request.params.id, secret: requireApprovalSecret(request), response });
    setSessionCookie(request, reply, result.token);
    return { ok: true };
  });
  app.post("/api/auth/login/options", authRateLimit(12), async () => {
    requireAuthEnabled(authMode);
    return auth.loginOptions();
  });
  app.post("/api/auth/login/verify", authRateLimit(12), async (request, reply) => {
    requireAuthEnabled(authMode);
    const value = z.object({ challengeId: z.string().uuid(), response: webAuthnAuthenticationResponseSchema }).parse(request.body);
    const result = await auth.login({ challengeId: value.challengeId, response: value.response as AuthenticationResponseJSON });
    setSessionCookie(request, reply, result.token);
    return { ok: true };
  });
  app.get("/api/auth/devices", async (request) => {
    return auth.listDevices(request.authIdentity!.credentialId);
  });
  app.delete<{ Params: { id: string } }>("/api/auth/devices/:id", async (request, reply) => {
    if (!auth.revokeDevice(request.params.id)) {
      throw new StoreError("auth_device_not_found", "设备不存在或已撤销");
    }
    if (request.authIdentity!.credentialId === request.params.id) clearSessionCookies(reply);
    await auth.ensureBootstrapRequest();
    return reply.code(204).send();
  });
  app.post("/api/auth/logout", async (request, reply) => {
    auth.logout(sessionToken(request));
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { conversationId?: string } }>("/api/bootstrap", async (request) => {
    const conversationId = request.query.conversationId;
    const conversation = conversationId ? store.getConversation(conversationId) : undefined;
    return {
      settings: store.getSettings(),
      agents: store.listAgents(),
      connections: store.listConnections(),
      models: store.listModels(),
      conversations: store.listConversations(),
      messages: conversation ? store.listMessages(conversation.id) : undefined
    };
  });

  app.get("/api/settings", async () => store.getSettings());
  app.patch("/api/settings", async (request) => {
    const patch = appSettingsSchema.partial().parse(request.body);
    if (patch.defaultModelId) {
      const model = store.getModel(patch.defaultModelId);
      if (!model) throw new StoreError("model_not_found", "默认模型不存在");
      if (!model.enabled) throw new StoreError("model_disabled", "默认模型已停用");
    }
    for (const agentId of [patch.defaultAgentId, patch.lastAgentId]) {
      if (agentId && !store.getAgent(agentId)) throw new StoreError("agent_not_found", "Agent 不存在");
    }
    return store.updateSettings(patch);
  });
  app.get("/api/agents", async () => store.listAgents());
  app.post("/api/agents", async (request, reply) => {
    const value = agentInputSchema.parse(request.body);
    return reply.code(201).send(store.createAgent(value));
  });
  app.post("/api/agents/import", async (request, reply) => {
    const value = encodedFileSchema.parse(request.body);
    return reply.code(201).send(importCharacterCard(store, value.fileName, Buffer.from(value.dataBase64, "base64")));
  });
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    return agent;
  });
  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const patch = agentInputSchema.partial().parse(request.body);
    const agent = store.updateAgent(request.params.id, patch);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    taskManager.notifyAgentPolicyChanged(request.params.id);
    return agent;
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (taskManager.hasNonterminalForAgent(request.params.id)) {
      throw new StoreError("agent_busy", "该 Agent 仍有排队或运行中的后台任务");
    }
    if (!store.deleteAgent(request.params.id)) throw new StoreError("agent_not_found", "Agent 不存在");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!store.getAgent(request.params.id)) throw new StoreError("agent_not_found", "Agent 不存在");
    const avatar = store.getAgentAvatar(request.params.id);
    if (!avatar) throw new StoreError("agent_avatar_not_found", "Agent 没有头像");
    return reply.type("image/png").send(Buffer.from(avatar));
  });
  app.put<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request) => {
    const value = encodedFileSchema.parse(request.body);
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (bytes.byteLength > 10 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new StoreError("agent_avatar_invalid", "头像必须是小于 10 MiB 的 PNG");
    }
    const agent = store.setAgentAvatar(request.params.id, bytes);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    return agent;
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    const agent = store.setAgentAvatar(request.params.id, null);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string }; Querystring: { format?: "json" | "png" } }>("/api/agents/:id/export", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    const exported = exportCharacterCard(store, agent, request.query.format ?? "json");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`);
    return reply.type(exported.contentType).send(Buffer.from(exported.bytes));
  });
  app.get("/api/tools/settings", async () => store.getToolSettings());
  app.patch("/api/tools/settings", async (request) => store.updateToolSettings(toolSettingsInputSchema.parse(request.body)));
  app.get("/api/tools/catalog", async () => registry.catalog());
  app.get("/api/plugins", async () => pluginManager.list());
  app.post("/api/plugins/install", async (request, reply) => {
    const value = z.object({ sourcePath: z.string().min(1).max(4096) }).parse(request.body);
    return reply.code(201).send(await userOperation("plugin_invalid", () => pluginManager.install(value.sourcePath)));
  });
  app.patch<{ Params: { id: string } }>("/api/plugins/:id/config", async (request) => {
    const value = z.object({ config: z.record(z.string(), z.unknown()).default({}), secrets: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    return userOperation("plugin_invalid", () => pluginManager.configure(request.params.id, value.config, value.secrets));
  });
  app.post<{ Params: { id: string } }>("/api/plugins/:id/reload", async (request) => userOperation("plugin_invalid", () => pluginManager.reload(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/plugins/:id/unload", async (request) => userOperation("plugin_invalid", () => pluginManager.unload(request.params.id)));
  app.delete<{ Params: { id: string } }>("/api/plugins/:id", async (request, reply) => {
    await userOperation("plugin_invalid", () => pluginManager.remove(request.params.id));
    return reply.code(204).send();
  });
  app.get("/api/skills", async () => skillManager.list());
  app.post("/api/skills/discover", async () => {
    return userOperation("skill_discovery_failed", () => skillManager.discover());
  });
  app.post("/api/skills/install", async (request, reply) => {
    const value = z.object({ sourcePath: z.string().min(1).max(4096) }).parse(request.body);
    return reply.code(201).send(await userOperation("skill_invalid", () => skillManager.install(value.sourcePath)));
  });
  app.post<{ Params: { id: string } }>("/api/skills/:id/reload", async (request) => userOperation("skill_invalid", () => skillManager.reload(request.params.id)));
  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    await userOperation("skill_invalid", () => skillManager.remove(request.params.id));
    return reply.code(204).send();
  });
  app.get<{ Querystring: { path?: string } }>("/api/filesystem/directories", async (request) => {
    return userOperation("workspace_invalid", () => listDirectories(request.query.path || parsePath(process.cwd()).root));
  });
  app.post("/api/filesystem/directories", async (request, reply) => {
    const value = z.object({ path: z.string().min(1).max(4096) }).parse(request.body);
    return reply.code(201).send({ path: await userOperation("workspace_invalid", () => createDirectory(value.path)) });
  });
  app.post("/api/filesystem/validate", async (request) => {
    const value = z.object({ path: z.string().min(1).max(4096) }).parse(request.body);
    return { path: await userOperation("workspace_invalid", () => canonicalWorkspace(value.path)) };
  });
  app.get("/api/memories", async () => store.listMemories());
  app.get("/api/mcp/servers", async () => store.listMcpServers());
  app.post("/api/mcp/servers", async (request, reply) => {
    const value = mcpServerInputSchema.parse(request.body);
    if (store.listMcpServers().some((item) => item.name === value.name)) throw new StoreError("mcp_name_conflict", "MCP 名称已存在");
    return reply.code(201).send(store.createMcpServer(value));
  });
  app.patch<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request) => {
    const value = mcpServerPatchSchema.parse(request.body);
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
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/connections/:id/balance",
    async (request) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) throw new StoreError("connection_not_found", "连接不存在");
      const query = z.object({ refresh: z.enum(["true", "false", "1", "0"]).optional() }).parse(request.query);
      return balanceService.get(connection, query.refresh === "true" || query.refresh === "1");
    }
  );
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
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : null;
    return reply.code(201).send(store.createConversation({ ...value, workspacePath }));
  });
  app.post("/api/conversations/start", async (request, reply) => {
    const value = startConversationSchema.parse(request.body);
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : null;
    const result = store.startConversation({ ...value, workspacePath });
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
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : value.workspacePath;
    const result = store.updateConversation(request.params.id, { ...value, ...(value.workspacePath !== undefined ? { workspacePath } : {}) });
    if (!result) throw new StoreError("conversation_not_found", "会话不存在");
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    if (store.isConversationBusy(request.params.id)) {
      throw new StoreError("conversation_busy", "请先停止当前生成，再删除会话");
    }
    if (taskManager.hasNonterminalForConversation(request.params.id)) {
      throw new StoreError("conversation_tasks_active", "请先停止该会话的后台任务，再删除会话");
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

  app.get<{ Querystring: { conversationId?: string; scope?: "current" | "all" } }>("/api/background-tasks", async (request) => {
    return taskManager.list(request.query.scope === "all" ? {} : request.query.conversationId ? { conversationId: request.query.conversationId } : {});
  });
  app.get<{ Params: { id: string } }>("/api/background-tasks/:id", async (request) => {
    const task = taskManager.get(request.params.id);
    if (!task) throw new StoreError("background_task_not_found", "后台任务不存在");
    return { task, events: taskManager.eventsFor(task.id) };
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>("/api/background-tasks/:id/output", async (request) => {
    if (!taskManager.get(request.params.id)) throw new StoreError("background_task_not_found", "后台任务不存在");
    const query = z.object({
      cursor: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().positive().max(32 * 1024).default(32 * 1024)
    }).parse(request.query);
    return taskManager.read(request.params.id, query.cursor, query.limit);
  });
  app.post<{ Params: { id: string } }>("/api/background-tasks/:id/stop", async (request) => {
    const value = z.object({ reason: z.string().trim().min(1).max(2_000) }).parse(request.body);
    if (!taskManager.get(request.params.id)) throw new StoreError("background_task_not_found", "后台任务不存在");
    return taskManager.stop(request.params.id, value.reason);
  });
  app.post<{ Params: { id: string } }>("/api/background-tasks/:id/resize", async (request) => {
    const value = z.object({ columns: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).parse(request.body);
    if (!taskManager.get(request.params.id)) throw new StoreError("background_task_not_found", "后台任务不存在");
    taskManager.resize(request.params.id, value.columns, value.rows);
    return { ok: true };
  });
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const lastId = Number(request.headers["last-event-id"] ?? 0);
    const send = (event: { id: number; type: string }) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = eventHub.subscribe(Number.isFinite(lastId) ? lastId : 0, send);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
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
    await taskManager.close();
    registry.close();
    await closeMcpManager(store);
    store.close();
  });
  return app;
}

async function userOperation<T>(code: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(code, error instanceof Error ? error.message : "操作失败");
  }
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

class AuthHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const deviceNameSchema = z.string().trim().min(1).max(80);
const webAuthnResponseBase = {
  id: z.string().min(1).max(2048),
  rawId: z.string().min(1).max(2048),
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).nullable().optional()
};
const webAuthnRegistrationResponseSchema = z.object({
  ...webAuthnResponseBase,
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).optional()
  }).passthrough()
}).passthrough();
const webAuthnAuthenticationResponseSchema = z.object({
  ...webAuthnResponseBase,
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().nullable().optional()
  }).passthrough()
}).passthrough();
const bootstrapSecretSchema = z.object({
  requestId: z.string().uuid(),
  secret: z.string().min(32).max(128)
});
const bootstrapVerifySchema = bootstrapSecretSchema.extend({
  deviceName: deviceNameSchema,
  response: webAuthnRegistrationResponseSchema
});
const enrollmentCredentialSchema = z.object({
  tabSecret: z.string().min(32).max(128),
  approvalSecret: z.string().min(32).max(128),
  response: webAuthnRegistrationResponseSchema
});

function authRateLimit(max: number) {
  return { config: { rateLimit: { max, timeWindow: 60 * 1000 } } };
}

function requireAuthEnabled(mode: AuthMode): void {
  if (mode !== "webauthn") throw new AuthHttpError(404, "not_found", "API 不存在");
}

function isPublicApiRoute(request: FastifyRequest): boolean {
  const pathname = request.url.split("?", 1)[0] ?? "";
  if (pathname === "/api/health") return true;
  return [
    /^\/api\/auth\/bootstrap\/(options|verify)$/,
    /^\/api\/auth\/enrollments\/options$/,
    /^\/api\/auth\/enrollments\/[^/]+\/(credential|status)$/,
    /^\/api\/auth\/approvals\/[^/]+(?:\/(options|verify))?$/,
    /^\/api\/auth\/login\/(options|verify)$/
  ].some((pattern) => pattern.test(pathname));
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function requireSafeTransport(request: FastifyRequest): void {
  if (request.protocol === "https" || request.hostname.toLowerCase() === "localhost") return;
  throw new AuthHttpError(426, "secure_transport_required", "远程访问必须使用 HTTPS");
}

function requireMutationSource(request: FastifyRequest, expectedOrigin: string): void {
  if (request.headers["x-llm-chat-request"] !== "1") {
    throw new AuthHttpError(403, "request_header_required", "缺少写请求验证标记");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new AuthHttpError(403, "cross_site_request_rejected", "已拒绝跨站请求");
  }
  const origin = request.headers.origin;
  if (origin) {
    let actual: string;
    try {
      actual = new URL(origin).origin;
    } catch {
      throw new AuthHttpError(403, "origin_mismatch", "请求来源无效");
    }
    if (actual !== expectedOrigin) throw new AuthHttpError(403, "origin_mismatch", "请求来源与公开地址不匹配");
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireApprovalSecret(request: FastifyRequest): string {
  const secret = singleHeader(request.headers["x-llm-chat-approval"]);
  if (!secret) throw new AuthError(401, "approval_secret_required", "二维码批准凭据缺失");
  return secret;
}

function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[sessionCookieName(request)];
}

function sessionCookieName(request: FastifyRequest): "__Host-llm_chat_session" | "llm_chat_session" {
  return request.protocol === "https" ? "__Host-llm_chat_session" : "llm_chat_session";
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  const secure = request.protocol === "https";
  reply.setCookie(sessionCookieName(request), token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: 180 * 24 * 60 * 60
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie("llm_chat_session", { path: "/", httpOnly: true, sameSite: "strict" });
  reply.clearCookie("__Host-llm_chat_session", { path: "/", httpOnly: true, sameSite: "strict", secure: true });
}

async function registerWeb(app: FastifyInstance): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../../web/dist");
  if (!existsSync(resolve(root, "index.html"))) return;
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders(reply, filePath) {
      const fileName = parsePath(filePath).base;
      if (filePath.includes(`${resolve(root, "assets")}/`) && /-[A-Za-z0-9_-]{8,}\./.test(fileName)) {
        reply.header("cache-control", "public, max-age=31536000, immutable");
      } else {
        reply.header("cache-control", "no-cache");
      }
    }
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "not_found", message: "API 不存在" } });
    }
    if (request.url.startsWith("/assets/")) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Asset not found");
    }
    return reply.header("cache-control", "no-cache").sendFile("index.html");
  });
}

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    runner: GenerationRunner;
  }
  interface FastifyRequest {
    authIdentity: AuthIdentity | null;
  }
}
