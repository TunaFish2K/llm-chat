import { errorI18n, withMessage } from "@llm-chat/i18n";
import { ConversationService } from "./conversations";
import { activeGenerationNotifications, publishGenerationState } from "./generation-notifications";
import { assertImageConfiguration } from "./image-configuration";
import { recoverInterruptedWork } from "./runtime/startup-recovery";
import { existsSync } from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  appSettingsUpdateSchema,
  agentInputSchema,
  agentModelSelectionSchema,
  agentSearchSecretInputSchema,
  connectionInputSchema,
  connectionInputPatchSchema,
  conversationInputSchema,
  conversationRoleplayStatePatchSchema,
  encodedFileSchema,
  fileUploadMetadataSchema,
  forkConversationSchema,
  imageGenerationInputSchema,
  imageUploadSchema,
  mcpServerInputSchema,
  mcpServerPatchSchema,
  modelInputSchema,
  patchConversationSchema,
  retryGenerationSchema,
  roleplayScriptExecutionSchema,
  roleplayPresetImportSchema,
  sendMessageSchema,
  startConversationSchema,
  toolApprovalInputSchema,
  toolSettingsInputSchema,
  serviceSettingsInputSchema,
  type FileAssetDto,
  type GenerationEvent,
  type ModelDto
} from "@llm-chat/contracts";
import { adapterFor, ProviderError } from "@llm-chat/providers";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { offlineManifest, offlineSourceId } from "./offline-history";
import { Store } from "./database";
import { StoreError } from "./errors";
import { exportCharacterCardWithAssets, importCharacterCardWithAssets } from "./character-card";
import { GenerationRunner } from "./generations";
import { TaskManager } from "./background-tasks";
import { EventHub } from "./events";
import { SseWriter } from "./sse-writer";
import { closeMcpManager, mcpManager } from "./mcp";
import { PluginManager } from "./plugins";
import { SkillManager } from "./skills";
import { ToolRegistry } from "./tool-registry";
import { canonicalWorkspace, createDirectory, listDirectories } from "./workspaces";
import { BalanceError, BalanceService } from "./balance";
import { AuthError, AuthManager, type AuthIdentity } from "./auth";
import { compactConversationContext, ContextError } from "./context";
import { ImageService } from "./images";
import { VisionService } from "./vision";
import { ModelCatalogService } from "./model-catalog";
import { MessageQueue } from "./message-queue";
import { ServiceSettings } from "./service-settings";
import { BrowserFetchManager } from "./browser-fetch";
import { ReadonlyShellManager } from "./readonly-shell";
import { AppTools } from "./app-tools";
import { importSillyTavernPreset } from "./roleplay";
import { executeRestrictedStscript } from "./stscript";
import { providerRequestContextForConversation } from "./provider-context";
import { ImageGenerationManager } from "./image-generation";

export interface AppOptions {
  dataFile: string;
  logger?: boolean;
  webRoot?: string;
  skillDiscoveryRoot?: string;
  authAnnounce?: (message: string) => void;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const webRoot = options.webRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  assertWebArtifact(webRoot);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 65 * 1024 * 1024
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyCompress, { global: true });
  app.addContentTypeParser("application/octet-stream", {
    parseAs: "buffer",
    bodyLimit: 64 * 1024 * 1024
  }, (_request, body, done) => done(null, body));
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
  // Only the empty preview runner receives executable-document permissions.
  // The main application keeps its existing script policy.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.split("?")[0] === "/render-frame.html" && [200, 304].includes(reply.statusCode)) {
      reply.header("content-security-policy", "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http: data:; img-src https: http: data: blob:; font-src https: http: data:; connect-src https: http: wss: ws:; media-src https: http: data: blob:; frame-src 'self' https: http:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin");
      reply.header("referrer-policy", "no-referrer");
    }
    return payload;
  });
  const store = new Store(options.dataFile);
  recoverInterruptedWork(store.sqlite);
  const imageService = new ImageService(store);
  await imageService.initialize();
  const visionService = new VisionService(store, imageService);
  const auth = new AuthManager(store, options.authAnnounce ?? ((message) => {
    if (options.logger !== false) process.stderr.write(`\n${message}\n`);
  }));
  await auth.ensurePassword();
  const balanceService = new BalanceService();
  const modelCatalog = new ModelCatalogService();
  const eventHub = new EventHub();
  const imageJobs = new ImageGenerationManager(store, imageService, eventHub);
  await imageJobs.initialize();
  const taskManager = new TaskManager(store, eventHub);
  const pluginManager = new PluginManager(store, eventHub);
  const skillManager = new SkillManager(store, eventHub,
    options.skillDiscoveryRoot === undefined ? {} : { discoveryRoot: options.skillDiscoveryRoot });
  await skillManager.initialize();
  const conversations = new ConversationService({
    store, tasks: taskManager, imageJobs, files: imageService, events: eventHub,
    startGeneration: (id) => runner.start(id)
  });
  const appTools = new AppTools({
    store, conversations, tasks: taskManager, plugins: pluginManager, skills: skillManager, files: imageService,
    events: eventHub, balance: balanceService, catalog: modelCatalog
  });
  const browser = new BrowserFetchManager();
  const readonlyShell = new ReadonlyShellManager();
  await readonlyShell.initialize();
  const registry = new ToolRegistry(store, taskManager, pluginManager, skillManager, imageService, appTools, imageJobs, browser, readonlyShell);
  const runner = new GenerationRunner(store, {
    onStateChange: (id) => publishGenerationState(store, eventHub, id),
    onSettled: (conversationId) => { queue.changed(conversationId); queue.kick(conversationId); },
    buildTools: (_currentStore, record) => registry.tools(record),
    prepareImages: (_currentStore, record, model, signal, onAnalysis) =>
      visionService.prepare(record, model, signal, onAnalysis),
    runtimePrompt: (_currentStore, record) => taskManager.runtimePrompt(record.conversationId),
    imageService
  });
  const queue = new MessageQueue(store, runner, imageService, eventHub, (conversationId, assets) => {
    const conversation = store.getConversation(conversationId)!;
    const resolved = store.resolveGeneration(conversation);
    assertImageConfiguration(store, resolved.agent.id, resolved.model.id,
      assets.filter((id) => store.getFileAsset(id)?.kind === "image"));
  });
  queue.initialize();
  const serviceSettings = new ServiceSettings(store);
  app.decorate("store", store);
  app.decorate("runner", runner);
  app.decorateRequest("authIdentity", null);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "validation_error", i18n: { key: "error.validation" }, message: "请求参数无效", details: z.treeifyError(error) }
      });
    }
    if (error instanceof StoreError) {
      const status = error.code === "client_update_required" ? 409 : error.code.endsWith("not_found") ? 404 : 400;
      return reply.code(status).send({ error: { code: error.code, message: error.message, ...(errorI18n(error) ? { i18n: errorI18n(error) } : {}) } });
    }
    if (error instanceof BalanceError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(errorI18n(error) ? { i18n: errorI18n(error) } : {}) } });
    }
    if (error instanceof AuthError || error instanceof AuthHttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(errorI18n(error) ? { i18n: errorI18n(error) } : {}) } });
    }
    if (error instanceof ProviderError) {
      return reply.code(error.status && error.status < 500 ? error.status : 502).send({
        error: { code: error.code, message: error.message, ...(errorI18n(error) ? { i18n: errorI18n(error) } : {}) }
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "internal_error", i18n: { key: "error.internal" }, message: "服务端发生错误" } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (!isReadMethod(request.method)) requireMutationSource(request);
    if (isPublicApiRoute(request)) return;
    const token = sessionToken(request);
    const identity = auth.authenticate(token);
    if (!identity) {
      return reply.code(401).send({ error: { code: "authentication_required", i18n: { key: "error.authentication_required" }, message: "请输入访问密码" } });
    }
    if (identity.refreshCookie) setSessionCookie(request, reply, token!);
    request.authIdentity = identity;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const immutableAsset = (request.method === "GET" || request.method === "HEAD")
      && (request.url.startsWith("/api/images/") || request.url.startsWith("/api/files/"));
    if (request.url.startsWith("/api/") && !immutableAsset) reply.header("cache-control", "no-store");
    return payload;
  });

  app.post("/api/images", async (request, reply) => {
    const value = imageUploadSchema.parse(request.body);
    const asset = await imageService.importBytes(value.fileName, Buffer.from(value.dataBase64, "base64"));
    return reply.code(201).send(asset);
  });
  app.post("/api/files", async (request, reply) => {
    const fileNameHeader = Array.isArray(request.headers["x-file-name"])
      ? request.headers["x-file-name"][0]
      : request.headers["x-file-name"];
    const mimeHeader = Array.isArray(request.headers["x-file-type"])
      ? request.headers["x-file-type"][0]
      : request.headers["x-file-type"];
    let fileName = "file";
    try { fileName = decodeURIComponent(fileNameHeader ?? "file"); } catch {}
    const metadata = fileUploadMetadataSchema.parse({ fileName, mimeType: mimeHeader ?? "application/octet-stream" });
    if (!Buffer.isBuffer(request.body)) throw withMessage(new StoreError("file_body_invalid", "文件请求体无效"), "error.invalid_file_request_body");
    return reply.code(201).send(await imageService.importFile(metadata.fileName, metadata.mimeType, request.body));
  });
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>("/api/files/:id", async (request, reply) => {
    const { asset, bytes } = await imageService.readFileAsset(request.params.id);
    if (request.query.v !== asset.sha256) {
      return reply.header("cache-control", "no-store").redirect(asset.url, 307);
    }
    return sendFileAsset(request, reply, asset, bytes);
  });
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>("/api/images/:id", async (request, reply) => {
    const { asset, bytes } = await imageService.readAsset(request.params.id);
    if (request.query.v !== asset.sha256) {
      return reply.header("cache-control", "no-store").redirect(asset.url, 307);
    }
    return sendFileAsset(request, reply, asset, bytes);
  });
  app.get<{ Querystring: { url?: string } }>("/api/image-proxy", async (request, reply) => {
    const value = z.object({ url: z.string().url().max(4096) }).parse(request.query);
    const proxied = await imageService.proxy(value.url);
    return reply.header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff")
      .type(proxied.mimeType).send(Buffer.from(proxied.bytes));
  });

  app.post("/api/auth/login", authRateLimit(8), async (request, reply) => {
    const value = z.object({ password: z.string().min(1).max(128) }).parse(request.body);
    const result = await auth.login(value.password);
    setSessionCookie(request, reply, result.token);
    return { ok: true };
  });
  app.put("/api/auth/password", async (request, reply) => {
    const value = z.object({ password: passwordSchema }).parse(request.body);
    const result = await auth.changePassword(request.authIdentity!.sessionId, value.password);
    setSessionCookie(request, reply, result.token);
    return { ok: true, sessionsRevoked: result.sessionsRevoked };
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

  app.get("/api/offline/manifest", async () => offlineManifest(store));
  app.get<{ Params: { id: string } }>("/api/offline/conversations/:id", async (request) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return { sourceId: offlineSourceId(store), revision: store.conversationCacheRevision(conversation.id), conversation, messages: store.listMessages(conversation.id) };
  });
  app.get("/api/settings", async () => store.getSettings());
  app.patch("/api/settings", async (request) => {
    const patch = appSettingsUpdateSchema.parse(request.body);
    for (const agentId of [patch.defaultAgentId, patch.lastAgentId]) {
      if (agentId && !store.getAgent(agentId)) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    }
    const saved = store.updateSettings(patch);
    eventHub.emit({ type: "resource-changed", resource: "settings" });
    return saved;
  });
  app.get("/api/agents", async () => store.listAgents());
  app.post("/api/agents", async (request, reply) => {
    const value = agentInputSchema.parse(request.body);
    return reply.code(201).send(store.createAgent(value));
  });
  app.post("/api/agents/import", async (request, reply) => {
    const value = encodedFileSchema.parse(request.body);
    return reply.code(201).send(await importCharacterCardWithAssets(
      store, imageService, value.fileName, Buffer.from(value.dataBase64, "base64")
    ));
  });
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    return agent;
  });
  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    const patch = agentInputSchema.partial().parse(request.body);
    const agent = store.updateAgent(request.params.id, patch);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    taskManager.notifyAgentPolicyChanged(request.params.id);
    return agent;
  });
  app.patch<{ Params: { id: string } }>("/api/agents/:id/model-selection", async (request) => {
    const { modelId } = agentModelSelectionSchema.parse(request.body);
    const agent = store.rememberAgentModel(request.params.id, modelId);
    eventHub.emit({ type: "resource-changed", resource: "agents" });
    return agent;
  });
  app.patch<{ Params: { id: string } }>("/api/agents/:id/search-secret", async (request) => {
    const value = agentSearchSecretInputSchema.parse(request.body);
    return store.updateAgentSearchSecret(request.params.id, value.provider, value.apiKey);
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/roleplay/presets/import", async (request, reply) => {
    const value = roleplayPresetImportSchema.parse(request.body);
    const agent = store.getAgent(request.params.id);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(value.dataBase64, "base64").toString("utf8"));
    } catch {
      throw withMessage(new StoreError("roleplay_preset_invalid", "预设文件不是有效的 JSON"), "error.the_preset_file_is_not_valid_json");
    }
    let preset;
    try {
      preset = importSillyTavernPreset(raw, value.fileName);
    } catch (error) {
      throw new StoreError("roleplay_preset_invalid", error instanceof Error ? error.message : "无法导入预设");
    }
    const updated = store.updateAgent(agent.id, {
      roleplay: {
        ...agent.roleplay,
        presets: [...agent.roleplay.presets, preset],
        defaultPresetId: agent.roleplay.defaultPresetId ?? preset.id
      }
    });
    return reply.code(201).send(updated);
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/roleplay/assets", async (request, reply) => {
    const metadata = z.object({
      fileName: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().max(255).default("application/octet-stream"),
      type: z.string().trim().min(1).max(100).default("asset"),
      dataBase64: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
    }).parse(request.body);
    const agent = store.getAgent(request.params.id);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    const asset = await imageService.importFile(
      metadata.fileName, metadata.mimeType, Buffer.from(metadata.dataBase64, "base64")
    );
    store.attachFileToAgent(agent.id, asset.id);
    const ext = metadata.fileName.split(".").at(-1)?.replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "bin";
    const roleplayAsset = {
      id: asset.id, type: metadata.type, name: asset.fileName, ext,
      uri: asset.url, mimeType: asset.mimeType, hash: asset.sha256
    };
    const updated = store.updateAgent(agent.id, {
      roleplay: { ...agent.roleplay, assets: [...agent.roleplay.assets, roleplayAsset] }
    });
    return reply.code(201).send(updated);
  });
  app.delete<{ Params: { id: string; assetId: string } }>("/api/agents/:id/roleplay/assets/:assetId", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    if (!agent.roleplay.assets.some((asset) => asset.id === request.params.assetId)) {
      throw withMessage(new StoreError("roleplay_asset_not_found", "角色素材不存在"), "error.character_asset_not_found");
    }
    store.detachFileFromAgent(agent.id, request.params.assetId);
    store.updateAgent(agent.id, {
      roleplay: {
        ...agent.roleplay,
        assets: agent.roleplay.assets.filter((asset) => asset.id !== request.params.assetId),
        personas: agent.roleplay.personas.map((persona) => persona.avatarAssetId === request.params.assetId
          ? { ...persona, avatarAssetId: null }
          : persona)
      }
    });
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    if (taskManager.hasNonterminalForAgent(request.params.id)) {
      throw withMessage(new StoreError("agent_busy", "该 Agent 仍有排队或运行中的后台任务"), "error.this_agent_still_has_queued_or_running_background_tasks");
    }
    if (!store.deleteAgent(request.params.id)) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    if (!store.getAgent(request.params.id)) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    const avatar = store.getAgentAvatar(request.params.id);
    if (!avatar) throw withMessage(new StoreError("agent_avatar_not_found", "Agent 没有头像"), "error.the_agent_has_no_avatar");
    return reply.type("image/png").send(Buffer.from(avatar));
  });
  app.put<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request) => {
    const value = encodedFileSchema.parse(request.body);
    const bytes = Buffer.from(value.dataBase64, "base64");
    if (bytes.byteLength > 10 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw withMessage(new StoreError("agent_avatar_invalid", "头像必须是小于 10 MiB 的 PNG"), "error.the_avatar_must_be_a_png_smaller_than_10_mib");
    }
    const agent = store.setAgentAvatar(request.params.id, bytes);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    return agent;
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id/avatar", async (request, reply) => {
    const agent = store.setAgentAvatar(request.params.id, null);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string }; Querystring: { format?: "json" | "png" | "charx" } }>("/api/agents/:id/export", async (request, reply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) throw withMessage(new StoreError("agent_not_found", "Agent 不存在"), "error.agent_not_found");
    const exported = await exportCharacterCardWithAssets(store, imageService, agent, request.query.format ?? "json");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`);
    return reply.type(exported.contentType).send(Buffer.from(exported.bytes));
  });
  app.get("/api/tools/settings", async () => store.getToolSettings());
  app.get("/api/tools/services", async () => serviceSettings.get());
  app.patch("/api/tools/services", async (request) => {
    const result = serviceSettings.update(serviceSettingsInputSchema.parse(request.body));
    eventHub.emit({ type: "resource-changed", resource: "tools" });
    return result;
  });
  app.patch("/api/tools/settings", async (request) => store.updateToolSettings(toolSettingsInputSchema.parse(request.body)));
  app.get<{ Querystring: { agentId?: string } }>("/api/tools/catalog", async (request) => registry.catalog(request.query.agentId));
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
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return userOperation("workspace_invalid", () => listDirectories(query.path ?? parsePath(process.cwd()).root));
  });
  app.post("/api/filesystem/directories", async (request, reply) => {
    const value = z.object({ path: z.string() }).parse(request.body);
    return reply.code(201).send({ path: await userOperation("workspace_invalid", () => createDirectory(value.path)) });
  });
  app.post("/api/filesystem/validate", async (request) => {
    const value = z.object({ path: z.string() }).parse(request.body);
    return { path: await userOperation("workspace_invalid", () => canonicalWorkspace(value.path)) };
  });
  app.get("/api/memories", async () => store.listMemories());
  app.get("/api/mcp/servers", async () => store.listMcpServers());
  app.post("/api/mcp/servers", async (request, reply) => {
    const value = mcpServerInputSchema.parse(request.body);
    if (store.listMcpServers().some((item) => item.name === value.name)) throw withMessage(new StoreError("mcp_name_conflict", "MCP 名称已存在"), "error.an_mcp_server_with_this_name_already_exists");
    return reply.code(201).send(store.createMcpServer(value));
  });
  app.patch<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request) => {
    const value = mcpServerPatchSchema.parse(request.body);
    const duplicate = value.name && store.listMcpServers().some((item) => item.name === value.name && item.id !== request.params.id);
    if (duplicate) throw withMessage(new StoreError("mcp_name_conflict", "MCP 名称已存在"), "error.an_mcp_server_with_this_name_already_exists");
    const result = store.updateMcpServer(request.params.id, value);
    if (!result) throw withMessage(new StoreError("mcp_server_not_found", "MCP 服务不存在"), "error.mcp_server_not_found");
    mcpManager(store).invalidate(request.params.id);
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request, reply) => {
    mcpManager(store).invalidate(request.params.id);
    if (!store.deleteMcpServer(request.params.id)) throw withMessage(new StoreError("mcp_server_not_found", "MCP 服务不存在"), "error.mcp_server_not_found");
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/test", async (request) => {
    if (!store.getMcpServer(request.params.id)) throw withMessage(new StoreError("mcp_server_not_found", "MCP 服务不存在"), "error.mcp_server_not_found");
    return mcpManager(store).test(request.params.id);
  });

  app.get("/api/connections", async () => store.listConnections());
  app.post("/api/connections", async (request, reply) => {
    const value = connectionInputSchema.parse(request.body);
    return reply.code(201).send(store.createConnection(value));
  });
  app.patch<{ Params: { id: string } }>("/api/connections/:id", async (request) => {
    const value = connectionInputPatchSchema.parse(request.body);
    const result = store.updateConnection(request.params.id, value);
    if (!result) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    return result;
  });
  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    if (!store.deleteConnection(request.params.id)) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/connections/:id/balance",
    async (request) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
      const query = z.object({ refresh: z.enum(["true", "false", "1", "0"]).optional() }).parse(request.query);
      return balanceService.get(connection, query.refresh === "true" || query.refresh === "1");
    }
  );
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", async (request) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    if (connection.providerId === "stability") return { ok: true, modelsFound: 0 };
    const models = await adapterFor(connection.protocol).listModels(
      connection,
      AbortSignal.timeout(15_000),
      providerRequestContextForConversation(connection.id, "models")
    );
    return { ok: true, modelsFound: models.length };
  });
  app.post<{ Params: { id: string } }>("/api/connections/:id/models/discover", async (request) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    if (connection.providerId === "stability") {
      return { discovered: 0, created: [], updated: [], skipped: 0, unmatched: 0, warnings: ["Stability 图片模型需要手动添加模型标识"] };
    }
    const discovered = await adapterFor(connection.protocol).listModels(
      connection,
      AbortSignal.timeout(15_000),
      providerRequestContextForConversation(connection.id, "models")
    );
    const enrichment = await modelCatalog.enrich(connection, discovered);
    const created: ModelDto[] = [];
    const updated: ModelDto[] = [];
    let skipped = 0;
    let unmatched = 0;
    for (const item of enrichment.models) {
      if (!item.matched) unmatched += 1;
      const result = store.upsertDiscoveredModel(item.input, item.catalogMetadata);
      if (result.status === "created") created.push(result.model);
      else if (result.status === "updated") updated.push(result.model);
      else skipped += 1;
    }
    return {
      discovered: discovered.length,
      created,
      updated,
      skipped,
      unmatched,
      warnings: enrichment.warning ? [enrichment.warning] : []
    };
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/models", async (request) => {
    return store.listModels(request.query.connectionId);
  });
  app.post("/api/models", async (request, reply) => {
    const value = modelInputSchema.parse(request.body);
    if (!store.getConnection(value.connectionId)) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    return reply.code(201).send(store.createModel(value));
  });
  app.patch<{ Params: { id: string } }>("/api/models/:id", async (request) => {
    const value = modelInputSchema.partial().parse(request.body);
    const result = store.updateModel(request.params.id, value);
    if (!result) throw withMessage(new StoreError("model_not_found", "模型不存在"), "error.model_not_found");
    return result;
  });
  app.post<{ Params: { id: string } }>("/api/models/:id/catalog/restore", async (request) => {
    const model = store.getModel(request.params.id);
    if (!model) throw withMessage(new StoreError("model_not_found", "模型不存在"), "error.model_not_found");
    const connection = store.getConnection(model.connectionId);
    if (!connection) throw withMessage(new StoreError("connection_not_found", "连接不存在"), "error.connection_not_found");
    const enriched = await modelCatalog.enrichOne(connection, model.modelKey, model.modelKey);
    if (!enriched?.catalogMetadata) {
      throw withMessage(new StoreError("model_catalog_match_not_found", "models.dev 中没有找到可信的模型匹配"), "error.no_trusted_model_match_found_in_models_dev");
    }
    return store.restoreCatalogModel(model.id, enriched.input, enriched.catalogMetadata)!;
  });
  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    if (!store.deleteModel(request.params.id)) throw withMessage(new StoreError("model_not_found", "模型不存在"), "error.model_not_found");
    return reply.code(204).send();
  });

  app.get("/api/conversations", async () => store.listConversations());
  app.post("/api/conversations", async (request, reply) => {
    const value = conversationInputSchema.parse(request.body ?? {});
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : null;
    return reply.code(201).send(store.createConversation({ ...value, workspacePath }));
  });
  app.post("/api/conversations/start", async (request, reply) => {
    requireCurrentMessageClient(request.body);
    const value = startConversationSchema.parse(request.body);
    value.executionOverrides = store.newConversationOverrides(value.agentId, value.executionOverrides);
    const imageAssetIds = attachmentIds(value).filter((id) => store.getFileAsset(id)?.kind === "image");
    if (imageAssetIds.length) {
      const agent = store.getAgent(value.agentId);
      const modelId = Object.hasOwn(value.executionOverrides, "modelId")
        ? value.executionOverrides.modelId ?? null
        : agent?.execution.modelId ?? null;
      assertImageConfiguration(store, agent?.id ?? null, modelId, imageAssetIds);
    }
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : null;
    const result = store.startConversation({ ...value, workspacePath });
    if (result.generation.userMessageId) {
      await imageService.materializeMessageAttachments(result.conversation.id, result.generation.userMessageId);
    }
    runner.start(result.generation.generationId);
    return reply.code(202).send(result);
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return conversation;
  });
  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const value = patchConversationSchema.parse(request.body);
    const workspacePath = value.workspacePath ? await userOperation("workspace_invalid", () => canonicalWorkspace(value.workspacePath!)) : value.workspacePath;
    const result = store.updateConversation(request.params.id, { ...value, ...(value.workspacePath !== undefined ? { workspacePath } : {}) });
    if (!result) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    if (value.modelId !== undefined || value.executionOverrides?.modelId !== undefined) {
      eventHub.emit({ type: "resource-changed", resource: "agents" });
    }
    return result;
  });
  app.patch<{ Params: { id: string } }>("/api/conversations/:id/active-branch", async (request) => {
    const value = z.object({ branchId: z.string().uuid() }).parse(request.body);
    return store.selectConversationBranch(request.params.id, value.branchId);
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/roleplay-state", async (request) => {
    return store.getConversationRoleplayState(request.params.id);
  });
  app.patch<{ Params: { id: string } }>("/api/conversations/:id/roleplay-state", async (request) => {
    const patch = conversationRoleplayStatePatchSchema.parse(request.body);
    return store.updateConversationRoleplayState(request.params.id, patch);
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/roleplay-scripts/execute", async (request) => {
    const input = roleplayScriptExecutionSchema.parse(request.body);
    const conversation = store.getConversation(request.params.id);
    if (!conversation?.agentId) throw withMessage(new StoreError("conversation_agent_required", "请先为会话选择 Agent"), "error.select_an_agent_for_this_conversation_first");
    const agent = store.getAgent(conversation.agentId);
    if (!agent?.roleplay.enabled) throw withMessage(new StoreError("roleplay_disabled", "当前 Agent 未启用角色扮演"), "error.roleplay_is_not_enabled_for_this_agent");
    let state = store.getConversationRoleplayState(conversation.id);
    const activeSets = agent.roleplay.quickReplySets.filter((set) =>
      set.enabled && state.enabledQuickReplySetIds.includes(set.id)
    );
    const selected = input.script
      ? [{ id: undefined, source: input.script, kind: "inline" as const }]
      : input.quickReplyId
      ? activeSets.flatMap((set) => set.replies).filter((reply) =>
          reply.enabled && reply.mode === "script" && reply.id === input.quickReplyId
        ).map((reply) => ({ id: reply.id, source: reply.content, kind: "quick_reply" as const }))
      : activeSets.flatMap((set) => set.replies).filter((reply) =>
          reply.enabled && reply.mode === "script" && input.trigger && reply.autoTriggers.includes(input.trigger)
        ).map((reply) => ({ id: reply.id, source: reply.content, kind: "trigger" as const }));
    if (!selected.length) throw withMessage(new StoreError("roleplay_script_not_found", "没有可执行的受限脚本"), "error.no_sandboxed_scripts_to_run");
    let draft = input.draft;
    let sendText: string | null = null;
    const output: string[] = [];
    let commandCount = 0;
    for (const script of selected) {
      try {
        const result = executeRestrictedStscript(script.source, draft, state, agent.roleplay);
        state = store.updateConversationRoleplayState(conversation.id, result.patch);
        draft = result.draft;
        sendText = result.sendText ?? sendText;
        output.push(...result.output);
        commandCount += result.commands;
        store.recordRoleplayScriptAudit({
          conversationId: conversation.id, agentId: agent.id, sourceKind: script.kind,
          ...(script.id ? { sourceId: script.id } : {}), commandCount: result.commands, success: true
        });
      } catch (error) {
        store.recordRoleplayScriptAudit({
          conversationId: conversation.id, agentId: agent.id, sourceKind: script.kind,
          ...(script.id ? { sourceId: script.id } : {}), commandCount: 0, success: false,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
    return { draft, sendText, output, state, commands: commandCount };
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/roleplay-scripts/audit", async (request) => {
    if (!store.getConversation(request.params.id)) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return store.listRoleplayScriptAudit(request.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    await conversations.delete(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/forks", async (request, reply) => {
    const value = forkConversationSchema.parse(request.body);
    const result = await conversations.fork(request.params.id, value);
    return reply.code(result.generation ? 202 : 201).send(result);
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/context/compact", async (request) => {
    if (!store.getConversation(request.params.id)) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return store.getContextSummary(request.params.id) ?? null;
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/context/compact", async (request, reply) => {
    if (store.isConversationBusy(request.params.id)) {
      throw withMessage(new StoreError("conversation_busy", "该会话还有生成或工具审批未完成"), "error.this_conversation_has_an_unfinished_generation_or_tool_approval_2");
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort(withMessage(new Error("压缩请求已断开"), "error.the_compaction_request_was_disconnected"));
    };
    reply.raw.once("close", onClose);
    try {
      return await compactConversationContext(store, request.params.id, controller.signal);
    } catch (error) {
      if (error instanceof ContextError) throw new StoreError(error.code, error.message);
      throw error;
    } finally {
      reply.raw.off("close", onClose);
    }
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request) => {
    if (!store.getConversation(request.params.id)) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return store.listMessages(request.params.id);
  });
  app.get<{ Querystring: { query?: string } }>("/api/conversations/search", async (request) => {
    const query = z.string().trim().max(200).parse(request.query.query ?? "");
    if (!query) return [];
    const matches = new Map(store.searchChats(query, 500).map((item) => [item.conversationId, { ...item, titleMatch: item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) }]));
    for (const conversation of store.listConversations()) {
      if (conversation.forkedFrom || !conversation.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      const id = conversation.activeBranchId ?? conversation.id;
      const previous = matches.get(id);
      matches.set(id, { conversationId: id, title: conversation.title, snippet: previous?.snippet ?? "", updatedAt: conversation.updatedAt, titleMatch: true });
    }
    return [...matches.values()].sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId)).slice(0, 50);
  });
  // Compatibility for cached clients: no history is loaded or changed.
  app.get<{ Params: { id: string } }>("/api/conversations/:id/history", async (request) => ({
    revision: 0, canUndo: false, canRedo: false, records: [], queuePaused: store.isQueuePaused(request.params.id)
  }));
  app.post<{ Params: { id: string } }>("/api/conversations/:id/history", async (request, reply) => {
    store.isQueuePaused(request.params.id);
    return reply.code(410).send({ error: { code: "history_retired", i18n: { key: "error.history_retired" }, message: "撤回功能已退役，请更新页面并使用分叉。" } });
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/queue", async (request) => ({
    items: store.listQueuedMessages(request.params.id), paused: store.isQueuePaused(request.params.id)
  }));
  app.post<{ Params: { id: string } }>("/api/conversations/:id/queue/resume", async (request) => {
    store.resumeQueue(request.params.id);
    queue.changed(request.params.id);
    queue.kick(request.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/conversations/:id/image-generations", async (request) => {
    if (!store.getConversation(request.params.id)) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
    return store.listImageGenerationJobs(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/image-generations", async (request, reply) => {
    const input = imageGenerationInputSchema.parse(request.body);
    const job = imageJobs.create({ conversationId: request.params.id, input });
    imageJobs.start(job.id);
    return reply.code(202).send(job);
  });
  app.get<{ Params: { id: string } }>("/api/image-generations/:id", async (request) => {
    const job = store.getImageGenerationJob(request.params.id);
    if (!job) throw withMessage(new StoreError("image_generation_not_found", "图片生成任务不存在"), "error.image_generation_task_not_found");
    return job;
  });
  app.post<{ Params: { id: string } }>("/api/image-generations/:id/cancel", async (request) => {
    return imageJobs.cancel(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/image-generations/:id/retry", async (request, reply) => {
    const previous = store.getImageGenerationJob(request.params.id);
    if (!previous) throw withMessage(new StoreError("image_generation_not_found", "图片生成任务不存在"), "error.image_generation_task_not_found");
    if (previous.status !== "failed" && previous.status !== "cancelled") {
      throw withMessage(new StoreError("image_generation_not_retryable", "当前图片任务不能重试"), "error.this_image_task_cannot_be_retried");
    }
    const input = store.getImageGenerationInput(previous.id);
    if (!input) throw withMessage(new StoreError("image_generation_config_invalid", "图片生成请求已损坏"), "error.the_image_generation_request_is_corrupt");
    const job = imageJobs.create({ conversationId: previous.conversationId, input });
    imageJobs.start(job.id);
    return reply.code(202).send(job);
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    requireCurrentMessageClient(request.body);
    if (!store.isQueuePaused(request.params.id) && store.listQueuedMessages(request.params.id).some((item) => item.status !== "failed")) {
      throw withMessage(new StoreError("conversation_busy", "已有待发送消息，请加入队列"), "error.messages_are_already_waiting_add_this_message_to_the_queue");
    }
    if (store.isConversationBusy(request.params.id)) throw withMessage(new StoreError("conversation_busy", "该会话还有生成或工具审批未完成"), "error.this_conversation_has_an_unfinished_generation_or_tool_approval_2");
    const value = sendMessageSchema.parse(request.body);
    const ids = attachmentIds(value);
    const imageAssetIds = ids.filter((id) => store.getFileAsset(id)?.kind === "image");
    if (imageAssetIds.length) {
      const conversation = store.getConversation(request.params.id);
      if (!conversation) throw withMessage(new StoreError("conversation_not_found", "会话不存在"), "error.conversation_not_found");
      const resolved = store.resolveGeneration(conversation);
      assertImageConfiguration(store, resolved.agent.id, resolved.model.id, imageAssetIds);
    }
    const result = store.createMessageGeneration(request.params.id, value.text, ids);
    if (result.userMessageId) {
      await imageService.materializeMessageAttachments(request.params.id, result.userMessageId);
    }
    runner.start(result.generationId);
    return reply.code(202).send(result);
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request) => store.listQueuedMessages(request.params.id));
  app.post<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request, reply) => {
    requireCurrentMessageClient(request.body);
    const value = sendMessageSchema.parse(request.body);
    const { mode } = z.object({ mode: z.enum(["queue", "steer"]).default("queue") }).parse(request.body);
    const item = store.enqueueMessage(request.params.id, value.text, attachmentIds(value), mode);
    queue.changed(request.params.id);
    queue.kick(request.params.id);
    return reply.code(202).send(item);
  });
  app.delete<{ Params: { id: string; itemId: string } }>("/api/conversations/:id/queued-messages/:itemId", async (request, reply) => {
    store.deleteQueuedMessages(request.params.id, request.params.itemId);
    queue.changed(request.params.id);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request, reply) => {
    store.deleteQueuedMessages(request.params.id);
    queue.changed(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/generations", async (request, reply) => {
    retryGenerationSchema.parse(request.body ?? {});
    const conversationId = store.conversationIdForMessage(request.params.id);
    if (!conversationId) throw withMessage(new StoreError("message_not_found", "助手消息不存在"), "error.assistant_message_not_found");
    if (store.isConversationBusy(conversationId)) throw withMessage(new StoreError("conversation_busy", "该会话还有生成或工具审批未完成"), "error.this_conversation_has_an_unfinished_generation_or_tool_approval_2");
    const result = store.createRetryGeneration(request.params.id);
    runner.start(result.generationId);
    return reply.code(202).send(result);
  });

  app.get<{ Querystring: { conversationId?: string; scope?: "current" | "all" } }>("/api/background-tasks", async (request) => {
    return taskManager.list(request.query.scope === "all" ? {} : request.query.conversationId ? { conversationId: request.query.conversationId } : {});
  });
  app.get<{ Params: { id: string } }>("/api/background-tasks/:id", async (request) => {
    const task = taskManager.get(request.params.id);
    if (!task) throw withMessage(new StoreError("background_task_not_found", "后台任务不存在"), "error.background_task_not_found");
    return { task, events: taskManager.eventsFor(task.id) };
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>("/api/background-tasks/:id/output", async (request) => {
    if (!taskManager.get(request.params.id)) throw withMessage(new StoreError("background_task_not_found", "后台任务不存在"), "error.background_task_not_found");
    const query = z.object({
      cursor: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().positive().max(32 * 1024).default(32 * 1024)
    }).parse(request.query);
    return taskManager.read(request.params.id, query.cursor, query.limit);
  });
  app.post<{ Params: { id: string } }>("/api/background-tasks/:id/stop", async (request) => {
    const value = z.object({ reason: z.string().trim().min(1).max(2_000) }).parse(request.body);
    if (!taskManager.get(request.params.id)) throw withMessage(new StoreError("background_task_not_found", "后台任务不存在"), "error.background_task_not_found");
    return taskManager.stop(request.params.id, value.reason);
  });
  app.post<{ Params: { id: string } }>("/api/background-tasks/:id/resize", async (request) => {
    const value = z.object({ columns: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).parse(request.body);
    if (!taskManager.get(request.params.id)) throw withMessage(new StoreError("background_task_not_found", "后台任务不存在"), "error.background_task_not_found");
    taskManager.resize(request.params.id, value.columns, value.rows);
    return { ok: true };
  });
  const streams = new Set<SseWriter>();
  const createEventStream = (reply: FastifyReply): SseWriter => {
    const stream = new SseWriter(reply.raw, (reason) => {
      streams.delete(stream);
      app.log.info({ reason, activeSse: streams.size }, "SSE connection closed");
    });
    streams.add(stream);
    return stream;
  };
  const memoryTimer = setInterval(() => {
    app.log.info({ ...process.memoryUsage(), activeGenerations: runner.activeCount, activeSse: streams.size,
      sseBufferedBytes: [...streams].reduce((sum, stream) => sum + stream.bufferedBytes, 0) }, "Runtime memory");
  }, 60_000);
  memoryTimer.unref();
  app.addHook("preClose", async () => {
    clearInterval(memoryTimer);
    for (const stream of streams) stream.close();
  });
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    // Flush an initial body frame so EventSource reaches `open` immediately
    // even when the event hub has nothing to replay yet.
    const stream = createEventStream(reply);
    stream.send(": connected\n\n");
    // No SSE id: the snapshot must not replace the replay cursor of other app events.
    // The synchronous snapshot and subscription have no intervening state changes.
    stream.send(`event: generation-snapshot\ndata: ${JSON.stringify({
      type: "generation-snapshot", id: eventHub.cursor, sourceId: offlineSourceId(store), active: activeGenerationNotifications(store)
    })}\n\n`);
    const header = request.headers["last-event-id"];
    const lastId = header === undefined ? NaN : Number(header);
    const replay = eventHub.canReplay(lastId);
    if (!replay) stream.send(`id: ${eventHub.cursor}\nevent: resync\ndata: ${JSON.stringify({ type: "resync", id: eventHub.cursor })}\n\n`);
    stream.addCleanup(eventHub.subscribe(replay ? lastId : eventHub.cursor, (event) => {
      stream.send(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }));
  });
  app.patch<{ Params: { id: string } }>("/api/messages/:id/active-generation", async (request) => {
    const value = z.object({ generationId: z.string().uuid() }).parse(request.body);
    if (!store.selectGeneration(request.params.id, value.generationId)) {
      throw withMessage(new StoreError("generation_not_found", "生成版本不存在"), "error.generation_version_not_found");
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/generations/:id", async (request) => {
    const generation = store.getGeneration(request.params.id);
    if (!generation) throw withMessage(new StoreError("generation_not_found", "生成不存在"), "error.generation_not_found");
    return generation;
  });
  app.get<{ Params: { id: string } }>("/api/generations/:id/events", async (request, reply) => {
    if (!store.getGeneration(request.params.id)) throw withMessage(new StoreError("generation_not_found", "生成不存在"), "error.generation_not_found");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const stream = createEventStream(reply);
    const send = (event: GenerationEvent) => {
      stream.send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const buffered: GenerationEvent[] = [];
    let snapshotSent = false;
    const unsubscribe = runner.subscribe(request.params.id, (event) => {
      if (!snapshotSent) {
        buffered.push(event);
        return;
      }
      send(event);
      if (event.type === "status" && isStreamEnd(event.status)) stream.end();
    });
    stream.addCleanup(unsubscribe);
    const generation = store.getGeneration(request.params.id)!;
    // subscribe synchronously replays the latest in-memory blocks. Fold them
    // into the snapshot so a large reply is not queued twice on reconnect.
    for (const event of buffered) if (event.type === "block-delta") {
      const index = generation.blocks.findIndex((block) => block.index === event.block.index && block.stepIndex === event.block.stepIndex);
      if (index < 0) generation.blocks.push(event.block); else generation.blocks[index] = event.block;
    }
    generation.blocks.sort((a, b) => a.index - b.index);
    send({ type: "snapshot", generation });
    snapshotSent = true;
    for (const event of buffered) if (event.type !== "block-delta") send(event);
    buffered.length = 0;
    if (isStreamEnd(generation.status)) {
      stream.end();
      return;
    }

  });
  app.post<{ Params: { id: string } }>("/api/generations/:id/cancel", async (request) => {
    const generation = store.getGeneration(request.params.id);
    if (!generation) throw withMessage(new StoreError("generation_not_found", "生成不存在"), "error.generation_not_found");
    const ok = runner.cancel(request.params.id);
    return { ok, status: store.getGeneration(request.params.id)?.status === "stopped" ? "stopped" : ok ? "stopping" : generation.status };
  });
  app.post<{ Params: { id: string } }>("/api/tool-calls/:id/approval", async (request) => {
    const value = toolApprovalInputSchema.parse(request.body);
    const call = store.getToolCall(request.params.id);
    if (!call) throw withMessage(new StoreError("tool_call_not_found", "工具调用不存在"), "error.tool_call_not_found");
    if (call.approvalState !== "pending") throw withMessage(new StoreError("tool_call_not_pending", "工具调用已处理"), "error.the_tool_call_has_already_been_handled");
    const generationId = store.generationIdForToolCall(call.id)!;
    const generation = store.getGeneration(generationId);
    if (generation?.status !== "waiting-approval") throw withMessage(new StoreError("generation_not_waiting", "生成当前不在等待审批"), "error.the_generation_is_not_waiting_for_approval");
    const updated = value.approved
      ? store.updateToolCall(call.id, { approvalState: "approved" })!
      : store.updateToolCall(call.id, {
          approvalState: "denied",
          output: JSON.stringify({ error: `Tool execution denied by user${value.reason ? `: ${value.reason}` : ""}` }),
          completedAt: Date.now()
        })!;
    const pending = store.listToolCalls(generationId).some((item) => item.approvalState === "pending");
    publishGenerationState(store, eventHub, generationId);
    if (!pending) runner.start(generationId);
    return { toolCall: updated, generationId, resumed: !pending };
  });

  await registerWeb(app, webRoot);

  app.addHook("onClose", async () => {
    await queue.close();
    await runner.close();
    await readonlyShell.close();
    await browser.close();
    await imageJobs.close();
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
    const wrapped = new StoreError(code, error instanceof Error ? error.message : "操作失败");
    const descriptor = errorI18n(error);
    throw descriptor ? withMessage(wrapped, descriptor.key, descriptor.params) : wrapped;
  }
}

function attachmentIds(value: { assetIds?: string[] | undefined; imageAssetIds?: string[] | undefined }): string[] {
  return [...new Set([...(value.assetIds ?? []), ...(value.imageAssetIds ?? [])])];
}

function sendFileAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  asset: FileAssetDto,
  bytes: Uint8Array
) {
  const etag = `"${asset.sha256}"`;
  reply.header("etag", etag);
  reply.header("cache-control", "private, max-age=31536000, immutable");
  reply.header("x-content-type-options", "nosniff");
  reply.header("accept-ranges", "bytes");
  if (asset.kind === "file") {
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`);
    reply.type("application/octet-stream");
  } else {
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`);
    reply.type(asset.mimeType);
  }
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  const range = request.headers.range;
  if (!range) return reply.header("content-length", bytes.byteLength).send(Buffer.from(bytes));
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return reply.code(416).header("content-range", `bytes */${bytes.byteLength}`).send();
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  const start = requestedStart ?? Math.max(0, bytes.byteLength - (requestedEnd ?? 0));
  const end = requestedStart === null ? bytes.byteLength - 1 : Math.min(bytes.byteLength - 1, requestedEnd ?? bytes.byteLength - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.byteLength) {
    return reply.code(416).header("content-range", `bytes */${bytes.byteLength}`).send();
  }
  const body = bytes.subarray(start, end + 1);
  return reply.code(206)
    .header("content-range", `bytes ${start}-${end}/${bytes.byteLength}`)
    .header("content-length", body.byteLength)
    .send(Buffer.from(body));
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

const passwordSchema = z.string().min(8).max(128);

function authRateLimit(max: number) {
  return { config: { rateLimit: {
    max, timeWindow: 60 * 1000,
    errorResponseBuilder: () => withMessage(new AuthHttpError(429, "rate_limit_exceeded", "登录尝试过于频繁，请稍后重试"), "error.too_many_sign_in_attempts_try_again_later")
  } } };
}

function isPublicApiRoute(request: FastifyRequest): boolean {
  const pathname = request.url.split("?", 1)[0] ?? "";
  if (pathname === "/api/health") return true;
  return pathname === "/api/auth/login";
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function requireMutationSource(request: FastifyRequest): void {
  if (request.headers["x-llm-chat-request"] !== "1") {
    throw withMessage(new AuthHttpError(403, "request_header_required", "缺少写请求验证标记"), "error.the_write_request_verification_marker_is_missing");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw withMessage(new AuthHttpError(403, "cross_site_request_rejected", "已拒绝跨站请求"), "error.cross_site_request_rejected");
  }
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

export function assertWebArtifact(root: string): void {
  if (!existsSync(resolve(root, "index.html"))) {
    throw new Error(`Web build artifact is missing: ${resolve(root, "index.html")}. Run pnpm build before starting the server.`);
  }
}

async function registerWeb(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    // Resolve files at request time so a running server survives web rebuilds
    // that replace content-hashed asset names.
    wildcard: true,
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
      return reply.code(404).send({ error: { code: "not_found", i18n: { key: "error.api_not_found" }, message: "API 不存在" } });
    }
    if (request.url.startsWith("/assets/")) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Asset not found");
    }
    return reply.header("cache-control", "no-cache").sendFile("index.html");
  });
}

function requireCurrentMessageClient(body: unknown): void {
  // A tab from the reverted release must not silently lose its retry protection.
  if (body && typeof body === "object" && Object.hasOwn(body, "clientRequestId")) {
    throw withMessage(new StoreError("client_update_required", "版本已回退，请刷新页面后重试"), "error.the_version_was_rolled_back_refresh_the_page_and_try_again");
  }
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
