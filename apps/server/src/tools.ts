import { builtinToolFormatters, type ToolFormatters } from "./tool-presentation";
import { spawn } from "node:child_process";
import { executeShell } from "./shell";
import type { BrowserFetchManager } from "./browser-fetch";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { access, glob, mkdir, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { imageGenerationInputSchema, type AgentSearchConfig, type ToolCatalogItemDto } from "@llm-chat/contracts";
import type { ProviderToolDefinition } from "@llm-chat/providers";
import type { Store } from "./database";
import type { AgentSnapshot } from "./generation-types";
import type { TaskManager } from "./background-tasks";
import type { ImageService } from "./images";
import type { ImageGenerationManager } from "./image-generation";
import type { CodexManager } from "./codex";
import { mcpManager } from "./mcp";
import { ServiceSettings } from "./service-settings";

const MAX_TOOL_OUTPUT = 32 * 1024;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface ServerTool extends ToolFormatters {
  error?: string | null;
  definition: ProviderToolDefinition;
  label: string;
  category: ToolCatalogItemDto["category"];
  available: boolean;
  requiresApproval: (input: JsonObject) => boolean | Promise<boolean>;
  execute: (input: JsonObject, signal: AbortSignal, context?: ToolExecutionContext) => Promise<string>;
  activatesTools?: (input: JsonObject) => string[] | Promise<string[]>;
  sourceKind?: "builtin" | "plugin" | "mcp";
  sourceId?: string;
  sourceName?: string;
  revision?: string;
}

export interface ToolExecutionContext {
  conversationId: string;
  generationId: string;
  toolCallId: string;
  snapshot: AgentSnapshot;
}

export interface ToolDependencies {
  browser?: BrowserFetchManager;
  lookup?: typeof lookup;
  taskManager?: TaskManager;
  imageService?: ImageService;
  imageManager?: ImageGenerationManager;
  codexManager?: CodexManager;
  workspacePath?: string | null;
  attachmentWorkspacePath?: string;
}

export async function buildServerTools(
  store: Store,
  includeDisabled = false,
  dependencies: ToolDependencies = {}
): Promise<ServerTool[]> {
  const workspace = Object.prototype.hasOwnProperty.call(dependencies, "workspacePath")
    ? dependencies.workspacePath ?? null
    : resolve(store.dataDir, "workspace");
  const skills = resolve(store.dataDir, "skills");
  const attachments = dependencies.attachmentWorkspacePath ?? null;
  await Promise.all([
    ...(workspace ? [mkdir(workspace, { recursive: true, mode: 0o700 })] : []),
    ...(attachments ? [mkdir(attachments, { recursive: true, mode: 0o700 })] : []),
    mkdir(skills, { recursive: true, mode: 0o700 })
  ]);
  const rootFor = (input: JsonObject): string => {
    const requested = input.workspace === "attachments" ? attachments : workspace;
    if (!requested) throw new Error(input.workspace === "attachments" ? "Conversation attachment workspace is unavailable" : "Conversation has no project workspace");
    return requested;
  };
  const services = new ServiceSettings(store);
  const workspaceProperty = { workspace: workspaceSelectorProperty() };

  const tools: ServerTool[] = [
    {
      ...tool("browser_fetch", "浏览器读取网页", "web", "Load a public webpage in an isolated headless Firefox browser, execute page JavaScript and return readable text. Use for pages that need a real browser. Does not solve CAPTCHAs or log in. Private addresses are blocked.", {
        url: stringProperty("Public HTTP or HTTPS URL")
      }, false, async (input, signal) => {
        if (!dependencies.browser) throw new Error("浏览器运行时不可用");
        return dependencies.browser.fetch(requiredString(input, "url"), signal);
      }, dependencies.browser?.available ?? false),
      error: dependencies.browser?.error ?? null
    },
    tool("get_time_info", "当前时间", "local", "Get the server's current local date, time, timezone, UTC offset, and Unix timestamp.", {}, false,
      async () => JSON.stringify(timeInfo())),
    tool("eval_javascript", "JavaScript", "local", "Run a calculation in an isolated JavaScript context. No Node.js, filesystem, network, or DOM APIs are available.", {
      code: stringProperty("JavaScript code to evaluate. The last expression is returned.")
    }, true, async (input, signal) => runJavascript(requiredString(input, "code"), signal)),
    tool("fetch_url", "读取网页", "web", "Fetch a public HTTP or HTTPS URL and return readable text. Private and loopback addresses are blocked.", {
      url: stringProperty("Public HTTP or HTTPS URL")
    }, false, async (input, signal) => fetchPublicText(requiredString(input, "url"), signal, dependencies.lookup ?? lookup)),
    tool("search_web", "网页搜索", "web", "Use action=list_engines to list available search services in recommended order. Use action=search (default) to search. Prefer earlier services unless another fits the task better. Omit engine_id to use the first available service. Returns titles, URLs, and snippets.", {
      action: { type: "string", enum: ["list_engines", "search"] },
      engine_id: stringProperty("Readable service id from list_engines, such as tavily or searxng"),
      query: stringProperty("Focused search query"),
      limit: integerProperty("Number of results, 1 to 10")
    }, false, async (input, signal) => {
      const engines = services.engines().filter((engine) => engine.available);
      if (input.action === "list_engines") return JSON.stringify({ engines: engines.map((engine, index) => ({ id: engine.id, name: engine.provider === "tavily" ? "Tavily" : "SearXNG", priority: index + 1 })) });
      const engine = input.engine_id ? engines.find((item) => item.id === input.engine_id) : engines[0];
      if (!engine) throw new Error("No matching enabled search engine. Use action=list_engines to see available services.");
      return searchWeb(engine, engine.apiKey, requiredString(input, "query"), optionalInteger(input, "limit", 5, 1, 10), signal);
    }),
    tool("image_generate", "生成图片", "local", "Use action=list_models to list available image models and readable model_id values in recommended order. Prefer earlier models unless another fits the task better. Use action=generate (default) with prompt and optional model_id to generate, edit, inpaint, or vary images. Omit model_id to use the first available model. Results are saved as image assets.", {
      action: { type: "string", enum: ["list_models", "generate"] },
      model_id: stringProperty("Readable model id returned by list_models, for example openai/gpt-image-2"),
      prompt: stringProperty("Image prompt"),
      operation: { type: "string", enum: ["generate", "edit", "inpaint", "variation"] },
      reference_asset_ids: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 4 },
      mask_asset_id: { type: ["string", "null"], format: "uuid" },
      negative_prompt: stringProperty("Optional negative prompt"),
      count: integerProperty("Number of images, 1 to 4"),
      aspect_ratio: stringProperty("Optional aspect ratio such as 1:1 or 16:9"),
      size: stringProperty("Provider image size"),
      quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
      output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
      seed: integerProperty("Optional deterministic seed"),
      strength: { type: "number", minimum: 0, maximum: 1 },
      provider_options: { type: "object", additionalProperties: true }
    }, (input) => input.action !== "list_models", async (input, signal, context) => {
      const models = services.images().filter((model) => model.available);
      if (input.action === "list_models") return JSON.stringify({ models: models.map(({ modelId: _internal, enabled: _enabled, available: _available, ...model }, index) => ({ ...model, model_id: model.id, priority: index + 1,
        operations: model.protocol === "google-imagen" ? ["generate"] : model.protocol === "google-interactions" ? ["generate", "edit"] : ["generate", "edit", "inpaint", "variation"] })) });
      if (!dependencies.imageManager || !context) throw new Error("Image generation service and tool context are required");
      const selected = input.model_id ? models.find((model) => model.id === input.model_id || model.modelId === input.model_id) : models[0];
      if (!selected) throw new Error("No matching enabled image model. Use action=list_models to see available model_id values.");
      const parsed = imageGenerationInputSchema.safeParse({
        modelId: selected.modelId,
        prompt: input.prompt,
        ...(input.operation !== undefined ? { operation: input.operation } : {}),
        ...(input.reference_asset_ids !== undefined ? { referenceAssetIds: input.reference_asset_ids } : {}),
        ...(input.mask_asset_id !== undefined ? { maskAssetId: input.mask_asset_id } : {}),
        ...(input.negative_prompt !== undefined ? { negativePrompt: input.negative_prompt } : {}),
        ...(input.count !== undefined ? { count: input.count } : {}),
        ...(input.aspect_ratio !== undefined ? { aspectRatio: input.aspect_ratio } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        ...(input.output_format !== undefined ? { outputFormat: input.output_format } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.strength !== undefined ? { strength: input.strength } : {}),
        ...(input.provider_options !== undefined ? { providerOptions: input.provider_options } : {})
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.path[0] === "modelId") {
          throw new Error("Choose a model_id returned by action=list_models.");
        }
        throw new Error(`image_generate 参数无效：${parsed.error.issues.map((item) => `${item.path.join(".") || "input"} ${item.message}`).join("；")}`);
      }
      const request = parsed.data;
      const job = await dependencies.imageManager.createAndWait({
        conversationId: context.conversationId,
        toolCallId: context.toolCallId,
        input: request
      }, signal);
      return JSON.stringify({
        jobId: job.id,
        status: job.status,
        revisedPrompt: job.revisedPrompt,
        assets: job.outputAssets,
        markdown: job.outputAssets.map((asset) => `![${asset.fileName}](${asset.url})`).join("\n")
      });
    }),
    tool("recent_chats", "最近对话", "conversation", "List recent conversation titles and update times. Use conversation_search to read matching content.", {
      limit: integerProperty("Number of conversations, 1 to 30")
    }, false, async (input) => JSON.stringify(store.recentChats(optionalInteger(input, "limit", 10, 1, 30)))),
    tool("conversation_search", "搜索对话", "conversation", "Search the user's server-side conversation history for a focused text query.", {
      query: stringProperty("Text to search for"),
      limit: integerProperty("Maximum results, 1 to 50")
    }, false, async (input) => JSON.stringify(store.searchChats(requiredString(input, "query"), optionalInteger(input, "limit", 15, 1, 50)))),
    tool("memory_tool", "长期记忆", "memory", "Create, edit, or delete durable user memories. Avoid sensitive personal data and merge duplicates.", {
      action: { type: "string", enum: ["create", "edit", "delete"], description: "Memory operation" },
      id: integerProperty("Memory id for edit or delete"),
      content: stringProperty("Memory text for create or edit")
    }, (input) => input.action === "delete", async (input) => memoryAction(store, input)),
    tool("workspace_list", "列出文件", "workspace", "List files and directories using paths relative to the conversation workspace root. Use . for the root; returned paths can be used directly by workspace file tools and shell commands.", {
      ...workspaceProperty,
      path: workspacePathProperty("Directory to list"),
      recursive: booleanProperty("List recursively")
    }, false, async (input) => listWorkspace(rootFor(input), optionalString(input, "path") ?? ".", Boolean(input.recursive)), Boolean(workspace || attachments)),
    tool("workspace_read_file", "读取文件", "workspace", "Read a UTF-8 text file using a path relative to the conversation workspace root (maximum 8 MiB). The returned path is also workspace-relative.", {
      ...workspaceProperty, path: workspacePathProperty("File to read")
    }, false, async (input) => readWorkspaceFile(rootFor(input), requiredString(input, "path")), Boolean(workspace || attachments)),
    tool("workspace_write_file", "写入文件", "workspace", "Write a UTF-8 text file using a path relative to the conversation workspace root. The returned path is also workspace-relative.", {
      ...workspaceProperty, path: workspacePathProperty("File to write"),
      text: stringProperty("Complete UTF-8 file content"),
      overwrite: booleanProperty("Whether an existing file may be replaced; defaults to true")
    }, true, async (input) => writeWorkspaceFile(rootFor(input), requiredString(input, "path"), requiredString(input, "text"), input.overwrite !== false), Boolean(workspace || attachments)),
    tool("workspace_edit_file", "编辑文件", "workspace", "Replace exact text in a UTF-8 file using a path relative to the conversation workspace root. The returned path is also workspace-relative.", {
      ...workspaceProperty, path: workspacePathProperty("File to edit"),
      old_text: stringProperty("Exact text to replace"),
      new_text: stringProperty("Replacement text"),
      replace_all: booleanProperty("Replace every occurrence; defaults to false")
    }, true, async (input) => editWorkspaceFile(rootFor(input), input), Boolean(workspace || attachments)),
    tool("workspace_glob", "查找文件", "workspace", "Find workspace-relative paths with a glob pattern such as **/*.ts. Returned paths can be used directly by workspace file tools and shell commands.", {
      ...workspaceProperty, pattern: stringProperty("Glob pattern relative to the selected workspace root; use . for the root. Legacy /workspace/... patterns are accepted.")
    }, false, async (input) => globWorkspace(rootFor(input), requiredString(input, "pattern")), Boolean(workspace || attachments)),
    tool("workspace_grep", "搜索文件", "workspace", "Search UTF-8 workspace files for plain text or a regular expression. Match paths are relative to the conversation workspace root and can be used directly by file tools and shell commands.", {
      ...workspaceProperty, query: stringProperty("Text or regular expression"),
      pattern: stringProperty("File glob relative to the conversation workspace root; defaults to **/* (all files). Legacy /workspace/... patterns are accepted."),
      regex: booleanProperty("Treat query as a JavaScript regular expression")
    }, false, async (input) => grepWorkspace(rootFor(input), input), Boolean(workspace || attachments)),
    tool("workspace_shell", "运行命令", "workspace", "Run a shell command with its working directory confined to the conversation workspace. Use workspace-relative paths in commands and . for the workspace root. Commands require explicit user approval.", {
      ...workspaceProperty, command: stringProperty("Shell command; use paths relative to the conversation workspace root selected by workspace"),
      cwd: workspacePathProperty("Working directory for the command"),
      timeout: integerProperty("Timeout in seconds, 1 to 120")
    }, true, async (input, signal) => runShell(rootFor(input), input, signal), Boolean(workspace || attachments)),
    tool("workspace_publish_image", "发布图片", "workspace", "Import an image from the conversation workspace into immutable llm-chat storage and return a permanent Markdown image link. Use this before showing a machine-local image to the user.", {
      ...workspaceProperty, path: workspacePathProperty("Image file to publish"),
      alt: stringProperty("Short alternative text for the image")
    }, false, async (input, _signal, context) => {
      if (!dependencies.imageService || !context) throw new Error("Image service and tool context are required");
      const asset = await dependencies.imageService.importWorkspaceImage(rootFor(input), requiredString(input, "path"));
      store.attachImageToToolCall(context.toolCallId, asset.id);
      const alt = (optionalString(input, "alt") ?? asset.fileName).replace(/[\[\]]/g, "").trim() || "image";
      return JSON.stringify({ asset, markdown: `![${alt}](${asset.url})` });
    }, Boolean((workspace || attachments) && dependencies.imageService)),
    tool("workspace_publish_file", "发布文件", "workspace", "Import a file from the selected workspace into immutable llm-chat storage and return a permanent Markdown link. Publishing requires approval because it exposes machine-local data to the user.", {
      ...workspaceProperty,
      path: workspacePathProperty("File to publish"),
      label: stringProperty("Optional download label"),
      mime_type: stringProperty("Optional MIME type; defaults to application/octet-stream")
    }, true, async (input, _signal, context) => {
      if (!dependencies.imageService || !context) throw new Error("File service and tool context are required");
      const asset = await dependencies.imageService.importWorkspaceFile(
        rootFor(input), requiredString(input, "path"), optionalString(input, "mime_type") ?? "application/octet-stream"
      );
      store.attachFileToToolCall(context.toolCallId, asset.id);
      const label = (optionalString(input, "label") ?? asset.fileName).replace(/[\[\]]/g, "").trim() || "file";
      const markdown = asset.kind === "image" ? `![${label}](${asset.url})` : `[${label}](${asset.url})`;
      return JSON.stringify({ asset, markdown });
    }, Boolean((workspace || attachments) && dependencies.imageService))
  ];

  if (dependencies.taskManager) tools.push(...backgroundTools(dependencies.taskManager, rootFor));
  if (dependencies.codexManager) tools.push(...codexTools(dependencies.codexManager));

  const skillList = await listSkills(skills);
  tools.push(tool("use_skill", "加载 Skill", "skill", skillList.length
    ? `Load a server-side skill's instructions or a linked file. Available skills: ${skillList.map((item) => `${item.name}: ${item.description}`).join("; ")}`
    : "Load a server-side skill's instructions.", {
      name: stringProperty("Skill name"),
      path: stringProperty("Optional relative file path from a link in SKILL.md")
    }, false, async (input) => useSkill(skills, skillList, input), skillList.length > 0));

  tools.push(...await mcpManager(store).tools());

  return tools;
}

function codexTools(manager: CodexManager): ServerTool[] {
  return [
    tool("codex_runtime", "Codex 状态", "background", "Read the local Codex runtime, app-server connection, version, and execution profile.", {}, false,
      async () => JSON.stringify(await manager.status())),
    tool("codex_sessions", "Codex 会话", "background", "List Codex sessions already bound to this conversation and discover attachable threads in its workspace.", {
      discover: { type: "boolean", description: "Also query Codex app-server for attachable threads" }
    }, false, async (input, _signal, context) => {
      if (!context) throw new Error("Tool execution context is required");
      const sessions = manager.listSessions(context.conversationId);
      const threads = input.discover === true ? await manager.listThreads(context.snapshot.workspacePath ?? undefined) : [];
      return JSON.stringify({ sessions, threads });
    }),
    tool("codex_start", "启动或接管 Codex", "background", "Start a new Codex coding session or attach a specific existing thread for this conversation. Use the current workspace only.", {
      thread_id: stringProperty("Optional Codex thread ID to resume and bind"),
      profile: { type: "string", enum: ["trusted-local-yolo", "server-workspace"], default: "server-workspace" }
    }, false, async (input, _signal, context) => {
      if (!context) throw new Error("Tool execution context is required");
      return JSON.stringify(await manager.create({
        conversationId: context.conversationId,
        ...(typeof input.thread_id === "string" ? { threadId: input.thread_id } : {}),
        profile: input.profile === "trusted-local-yolo" ? "trusted-local-yolo" : "server-workspace"
      }));
    }),
    tool("codex_send", "发送 Codex 任务", "background", "Send a coding instruction to the bound Codex session. Codex owns the file edits; inspect its result before claiming completion.", {
      session_id: stringProperty("Bound Codex session id"), text: stringProperty("Coding instruction for Codex")
    }, false, async (input, _signal, context) => {
      requireCodexContext(context);
      return JSON.stringify(await manager.send(requiredString(input, "session_id"), { text: requiredString(input, "text") }));
    }),
    tool("codex_wait", "等待 Codex", "background", "Wait for new Codex events or a state change and return the incremental structured event list.", {
      session_id: stringProperty("Bound Codex session id"), cursor: integerProperty("Last Codex event id"), timeout_seconds: integerProperty("Wait timeout from 1 to 120 seconds")
    }, false, async (input, signal, context) => {
      requireCodexContext(context);
      const result = await manager.wait(requiredString(input, "session_id"), optionalInteger(input, "cursor", 0, 0, Number.MAX_SAFE_INTEGER),
        optionalInteger(input, "timeout_seconds", 30, 1, 120) * 1_000, signal);
      return JSON.stringify(result);
    }),
    tool("codex_respond", "响应 Codex 请求", "background", "Respond to a pending structured Codex approval or user-input request. Keep the response inside the configured execution policy.", {
      session_id: stringProperty("Bound Codex session id"), request_id: stringProperty("Codex request id"), response: { type: "object", description: "Protocol response payload" }
    }, false, async (input, _signal, context) => {
      requireCodexContext(context);
      const response = input.response && typeof input.response === "object" && !Array.isArray(input.response)
        ? input.response as Record<string, unknown> : {};
      return JSON.stringify(await manager.respond(requiredString(input, "session_id"), {
        requestId: requiredString(input, "request_id"), response
      }));
    }),
    tool("codex_interrupt", "中断 Codex", "background", "Interrupt the active Codex turn while keeping its persisted thread bound to the conversation.", {
      session_id: stringProperty("Bound Codex session id")
    }, false, async (input, _signal, context) => {
      requireCodexContext(context);
      return JSON.stringify(await manager.interrupt(requiredString(input, "session_id")));
    })
  ];
}

function requireCodexContext(context?: ToolExecutionContext): asserts context is ToolExecutionContext {
  if (!context) throw new Error("Tool execution context is required");
  if (!context.snapshot.workspacePath) throw new Error("Conversation has no workspace");
}

export async function toolCatalog(store: Store, dependencies: ToolDependencies = {}): Promise<ToolCatalogItemDto[]> {
  const tools = await buildServerTools(store, true, dependencies);
  return Promise.all(tools.map(async (entry): Promise<ToolCatalogItemDto> => ({
    name: entry.definition.name,
    label: entry.label,
    description: TOOL_UI_DESCRIPTIONS[entry.definition.name] ?? entry.definition.description,
    category: entry.category,
    requiresApproval: await entry.requiresApproval({}),
    available: entry.available,
    approvalMode: "dynamic",
    sourceKind: entry.sourceKind ?? (entry.category === "mcp" ? "mcp" : "builtin"),
    ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
    ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
    ...(entry.revision ? { revision: entry.revision } : {})
  })));
}

const TOOL_UI_DESCRIPTIONS: Record<string, string> = {
  get_time_info: "读取服务端当前日期、时间、时区和时间戳。",
  eval_javascript: "在无 Node.js、文件、网络和 DOM 权限的隔离环境中执行计算。",
  fetch_url: "读取公开 HTTP/HTTPS 网页；自动阻止私网和回环地址。",
  search_web: "列出全局可用搜索引擎，或选择引擎搜索网页。",
  image_generate: "使用已配置的图片模型生成、编辑或变体图片。",
  recent_chats: "列出最近对话的标题和更新时间。",
  conversation_search: "在服务端保存的历史对话中搜索内容。",
  memory_tool: "增删改跨会话长期记忆；记忆会加入后续对话上下文。",
  workspace_list: "列出服务端沙箱工作区中的文件和目录。",
  workspace_read_file: "读取沙箱工作区内的 UTF-8 文本文件。",
  workspace_write_file: "在沙箱工作区内创建或覆盖文本文件。",
  workspace_edit_file: "通过精确文本替换修改沙箱工作区文件。",
  workspace_glob: "使用 glob 模式查找沙箱工作区文件。",
  workspace_grep: "按文本或正则表达式搜索沙箱工作区文件。",
  workspace_shell: "在沙箱工作区目录中运行 Shell 命令，每次执行均需批准。",
  workspace_publish_image: "把工作区图片导入为不可变应用资产，并返回可在回复中使用的永久 Markdown 链接。",
  workspace_publish_file: "把工作区文件导入为不可变应用资产，并返回永久下载链接。发布前需要批准。",
  codex_runtime: "检查本机 Codex 和 app-server 状态。",
  codex_sessions: "列出当前会话绑定或可接管的 Codex 会话。",
  codex_start: "启动新的 Codex 会话或接管已有 thread。",
  codex_send: "向 Codex 发送编码任务。",
  codex_wait: "等待 Codex 的结构化进度事件。",
  codex_respond: "响应 Codex 的审批或输入请求。",
  codex_interrupt: "中断当前 Codex turn。",
  use_skill: "按需加载服务端 Skills 目录中的专用说明。"
};

function backgroundTools(manager: TaskManager, rootFor: (input: JsonObject) => string): ServerTool[] {
  return [
    tool("background_start", "启动后台任务", "background", "Start a long-running command in the frozen conversation workspace and return its task id immediately. Use paths relative to the workspace root in the command.", {
      workspace: workspaceSelectorProperty(),
      command: stringProperty("Shell command; use paths relative to the selected workspace root"),
      mode: { type: "string", enum: ["pipe", "pty"], description: "Use pty for interactive terminal programs" },
      expected_duration_seconds: integerProperty("Optional expected duration in seconds"),
      hard_timeout_seconds: integerProperty("Optional hard timeout in seconds")
    }, true, async (input, _signal, context) => {
      if (!context) throw new Error("Tool execution context is required");
      const task = manager.create({
        conversationId: context.conversationId, generationId: context.generationId, snapshot: context.snapshot,
        workspacePath: rootFor(input),
        command: requiredString(input, "command"), mode: input.mode === "pty" ? "pty" : "pipe",
        expectedDurationMs: optionalPositiveSeconds(input, "expected_duration_seconds"),
        hardTimeoutMs: optionalPositiveSeconds(input, "hard_timeout_seconds")
      });
      return JSON.stringify(task);
    }),
    tool("background_list", "后台任务列表", "background", "List background tasks for this conversation.", {}, false,
      async (_input, _signal, context) => JSON.stringify(manager.list(context ? { conversationId: context.conversationId } : {}))),
    tool("background_status", "后台任务状态", "background", "Read current background task metadata.", {
      task_id: stringProperty("Background task id")
    }, false, async (input, _signal, context) => JSON.stringify(requireOwnedTask(manager, requiredString(input, "task_id"), context))),
    tool("background_read", "读取后台输出", "background", "Read incremental task output from a byte cursor. PTY tasks also return a terminal screen projection.", {
      task_id: stringProperty("Background task id"), cursor: integerProperty("Last returned cursor"), limit: integerProperty("Maximum bytes, capped at 32768")
    }, false, async (input, _signal, context) => {
      const id = requiredString(input, "task_id");
      requireOwnedTask(manager, id, context);
      return JSON.stringify(await manager.read(id, optionalInteger(input, "cursor", 0, 0, Number.MAX_SAFE_INTEGER), optionalInteger(input, "limit", MAX_TOOL_OUTPUT, 1, MAX_TOOL_OUTPUT)));
    }),
    tool("background_wait", "等待后台输出", "background", "Wait until output settles, task state changes, or timeout expires. Cancelling this call does not stop the task.", {
      task_id: stringProperty("Background task id"), cursor: integerProperty("Last returned cursor"),
      timeout_seconds: integerProperty("Wait timeout, 1 to 120 seconds"), quiet_period_ms: integerProperty("Output quiet period")
    }, false, async (input, signal, context) => {
      const id = requiredString(input, "task_id");
      requireOwnedTask(manager, id, context);
      return JSON.stringify(await abortable(manager.wait(
      id, optionalInteger(input, "cursor", 0, 0, Number.MAX_SAFE_INTEGER),
      optionalInteger(input, "timeout_seconds", 30, 1, 120) * 1_000,
      optionalInteger(input, "quiet_period_ms", 500, 0, 30_000)
    ), signal));
    }),
    tool("background_write", "写入后台终端", "background", "Send raw input to a running background task. A non-empty audit reason is required.", {
      task_id: stringProperty("Background task id"), data: stringProperty("Raw input"), reason: stringProperty("Audit reason")
    }, true, async (input, _signal, context) => {
      const id = requiredString(input, "task_id"); requireOwnedTask(manager, id, context);
      return JSON.stringify(manager.write(id, requiredString(input, "data"), requiredString(input, "reason")));
    }),
    tool("background_stop", "停止后台任务", "background", "Stop a queued or running background task. A non-empty audit reason is required.", {
      task_id: stringProperty("Background task id"), reason: stringProperty("Audit reason")
    }, true, async (input, _signal, context) => {
      const id = requiredString(input, "task_id"); requireOwnedTask(manager, id, context);
      return JSON.stringify(manager.stop(id, requiredString(input, "reason")));
    })
  ];
}

function requireOwnedTask(manager: TaskManager, id: string, context?: ToolExecutionContext) {
  const task = manager.get(id);
  if (!task) throw new Error("Background task not found");
  if (context && task.conversationId !== context.conversationId) throw new Error("Background task belongs to another conversation");
  return task;
}

function optionalPositiveSeconds(input: JsonObject, name: string): number | null {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value * 1_000) : null;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function toolSystemPrompt(store: Store): string {
  const memories = store.listMemories();
  if (!memories.length) return "";
  return `<memories>\n${memories.map((item) => `  <memory id="${item.id}">${escapeXml(item.content)}</memory>`).join("\n")}\n</memories>`;
}

export async function persistLargeToolOutput(store: Store, callId: string, output: string): Promise<string> {
  if (output.length <= MAX_TOOL_OUTPUT) return output;
  const directory = resolve(store.dataDir, "tool_outputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeName = callId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = resolve(directory, `${safeName}.txt`);
  await writeFile(path, output, { mode: 0o600 });
  try {
    const result = JSON.parse(output);
    if (typeof result?.stdout === "string" && typeof result?.stderr === "string") {
      return JSON.stringify({ ...result, stdout: result.stdout.slice(-4096), stderr: result.stderr.slice(-4096),
        truncated: true, fullOutputPath: path, originalCharacters: output.length });
    }
  } catch { /* Non-JSON tools retain their plain-text preview. */ }
  return `${output.slice(0, 4096)}\n\n[Output truncated: ${output.length} characters. Full output saved server-side at ${path}]`;
}

function tool(
  name: string,
  label: string,
  category: ServerTool["category"],
  description: string,
  properties: Record<string, unknown>,
  approval: boolean | ((input: JsonObject) => boolean),
  execute: ServerTool["execute"],
  available = true
): ServerTool {
  return {
    ...builtinToolFormatters(name),
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties, required: inferRequired(name) }
    },
    label,
    category,
    available,
    requiresApproval: typeof approval === "function" ? approval : () => approval,
    execute
  };
}

function inferRequired(name: string): string[] {
  return ({
    eval_javascript: ["code"], fetch_url: ["url"], browser_fetch: ["url"], search_web: [], conversation_search: ["query"], image_generate: [],
    memory_tool: ["action"], workspace_read_file: ["path"], workspace_write_file: ["path", "text"],
    workspace_edit_file: ["path", "old_text", "new_text"], workspace_glob: ["pattern"],
    workspace_grep: ["query"], workspace_shell: ["command"], use_skill: ["name"],
    background_start: ["command"], background_status: ["task_id"], background_read: ["task_id"],
    background_wait: ["task_id"], background_write: ["task_id", "data", "reason"], background_stop: ["task_id", "reason"],
    codex_send: ["session_id", "text"], codex_wait: ["session_id"],
    codex_respond: ["session_id", "request_id", "response"], codex_interrupt: ["session_id"]
  } as Record<string, string[]>)[name] ?? [];
}

function stringProperty(description: string): JsonObject { return { type: "string", description }; }
function workspacePathProperty(subject: string): JsonObject {
  return stringProperty(`${subject}, relative to the conversation workspace root. Use . for the root. Legacy /workspace paths are accepted.`);
}
function workspaceSelectorProperty(): JsonObject {
  return { type: "string", enum: ["project", "attachments"], default: "project", description: "Select project workspace or the isolated conversation attachment workspace" };
}
function integerProperty(description: string): JsonObject { return { type: "integer", description }; }
function booleanProperty(description: string): JsonObject { return { type: "boolean", description }; }

function requiredString(input: JsonObject, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
function optionalString(input: JsonObject, name: string): string | undefined {
  return typeof input[name] === "string" ? input[name] as string : undefined;
}
function optionalInteger(input: JsonObject, name: string, fallback: number, min: number, max: number): number {
  const value = typeof input[name] === "number" ? Math.floor(input[name]) : fallback;
  return Math.min(max, Math.max(min, value));
}

function timeInfo(): JsonObject {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    datetime: now.toISOString(),
    local_datetime: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long", timeZone: zone }).format(now),
    timezone: zone,
    utc_offset_minutes: -now.getTimezoneOffset(),
    timestamp_ms: now.getTime()
  };
}

async function runJavascript(code: string, signal: AbortSignal): Promise<string> {
  const wrapper = `const vm=require('node:vm');const code=Buffer.from(process.argv[1],'base64').toString();const logs=[];const console=Object.freeze({log:(...v)=>logs.push(v.join(' ')),info:(...v)=>logs.push(v.join(' ')),warn:(...v)=>logs.push(v.join(' ')),error:(...v)=>logs.push(v.join(' '))});try{const result=vm.runInNewContext(code,{console},{timeout:1500});process.stdout.write(JSON.stringify({result:result===undefined?null:result,logs}));}catch(error){process.stderr.write(String(error&&error.message||error));process.exitCode=1;}`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--permission", "-e", wrapper, Buffer.from(code).toString("base64")], {
      stdio: ["ignore", "pipe", "pipe"], signal
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk).slice(0, MAX_TOOL_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 4_096); });
    child.on("error", reject);
    child.on("close", (codeValue) => {
      clearTimeout(timer);
      if (codeValue === 0) resolvePromise(stdout || JSON.stringify({ result: null, logs: [] }));
      else reject(new Error(stderr || "JavaScript execution failed"));
    });
  });
}

const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";

function searchEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  if (endpoint.pathname === "/" || !endpoint.pathname) endpoint.pathname = "/search";
  return endpoint;
}

async function searchWeb(
  config: AgentSearchConfig | undefined,
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal
): Promise<string> {
  if (!config) throw new Error("Web search is not configured for this Agent");
  if (config.provider === "tavily") {
    if (!apiKey) throw new Error("Tavily API key is not configured");
    const response = await fetch(searchEndpoint(config.baseUrl || DEFAULT_TAVILY_BASE_URL), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false
      }),
      signal
    });
    if (!response.ok) throw new Error(`Tavily search returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return JSON.stringify((payload.results ?? []).slice(0, limit).map((item, index) => ({
      id: index + 1, title: item.title ?? "", url: item.url ?? "", text: item.content ?? ""
    })));
  }

  if (!config.baseUrl) throw new Error("SearXNG is not configured");
  const endpoint = searchEndpoint(config.baseUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal
  });
  if (!response.ok) throw new Error(`SearXNG search returned HTTP ${response.status}`);
  const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return JSON.stringify((payload.results ?? []).slice(0, limit).map((item, index) => ({
    id: index + 1, title: item.title ?? "", url: item.url ?? "", text: item.content ?? ""
  })));
}

async function fetchPublicText(rawUrl: string, signal: AbortSignal, resolveHost: typeof lookup): Promise<string> {
  let current = new URL(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    await assertPublicUrl(current, resolveHost);
    const response = await fetch(current, { redirect: "manual", headers: { "user-agent": "llm-chat-tool/1.0", accept: "text/html,text/plain,application/json" }, signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response has no Location header");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`URL returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_FETCH_BYTES) throw new Error("Response is larger than 2 MiB");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FETCH_BYTES) throw new Error("Response is larger than 2 MiB");
    const contentType = response.headers.get("content-type") ?? "";
    const raw = new TextDecoder().decode(bytes);
    const text = contentType.includes("text/html") ? htmlToText(raw) : raw;
    return JSON.stringify({ url: current.toString(), contentType, text: text.slice(0, MAX_TOOL_OUTPUT) });
  }
  throw new Error("Too many redirects");
}

export async function assertPublicUrl(url: URL, resolveHost: typeof lookup): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveHost(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private or loopback addresses are blocked");
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
    // Only global unicast; reject mapped IPv4, local, multicast and transition ranges.
    return !/^[23][0-9a-f]{3}:/.test(normalized) || /^2001:(?:0:|db8:)/.test(normalized)
      || normalized.startsWith("2001::") || normalized.startsWith("2002:");
  }
  if (isIP(address) !== 4) return true;
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
    || (parts[0] === 198 && [18, 19].includes(parts[1]!))
    || parts[0]! >= 224;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

async function memoryAction(store: Store, input: JsonObject): Promise<string> {
  const action = requiredString(input, "action");
  if (action === "create") return JSON.stringify(store.createMemory(requiredString(input, "content")));
  const id = optionalInteger(input, "id", 0, 1, Number.MAX_SAFE_INTEGER);
  if (action === "edit") return JSON.stringify(store.updateMemory(id, requiredString(input, "content")));
  if (action === "delete") { store.deleteMemory(id); return JSON.stringify({ success: true, id }); }
  throw new Error(`Unknown memory action: ${action}`);
}

async function workspacePath(root: string, input: string, mustExist = true): Promise<string> {
  const relativePath = normalizeWorkspaceInput(input);
  if (isAbsolute(relativePath)) throw new Error("Path must be inside /workspace");
  const target = resolve(root, relativePath || ".");
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Path escapes /workspace");
  if (mustExist) {
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(target);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Path resolves outside /workspace");
  }
  return target;
}

function normalizeWorkspaceInput(input: string): string {
  if (input === "/workspace") return ".";
  if (input.startsWith("/workspace/")) return input.slice("/workspace/".length) || ".";
  return input || ".";
}

function displayWorkspacePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value || ".";
}

async function listWorkspace(root: string, path: string, recursive: boolean): Promise<string> {
  const target = await workspacePath(root, path);
  const entries = await readdir(target, { withFileTypes: true, recursive });
  return JSON.stringify(entries.slice(0, 1_000).map((entry) => ({
    name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    path: displayWorkspacePath(root, resolve(entry.parentPath, entry.name))
  })));
}

async function readWorkspaceFile(root: string, path: string): Promise<string> {
  const target = await workspacePath(root, path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > MAX_FILE_BYTES) throw new Error("File is larger than 8 MiB");
  return JSON.stringify({ path: displayWorkspacePath(root, target), text: await readFile(target, "utf8") });
}

async function safeWriteTarget(root: string, path: string): Promise<string> {
  const target = await workspacePath(root, path, false);
  const canonicalRoot = await realpath(root);
  const parent = dirname(target);
  let existingAncestor = parent;
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error("Path resolves outside /workspace");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existingAncestor = dirname(existingAncestor);
    }
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Path resolves outside /workspace");
  }
  try {
    const canonical = await realpath(target);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error("Path resolves outside /workspace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

async function writeWorkspaceFile(root: string, path: string, text: string, overwrite: boolean): Promise<string> {
  const target = await safeWriteTarget(root, path);
  if (!overwrite) {
    try { await access(target, constants.F_OK); throw new Error("File already exists"); } catch (error) {
      if (error instanceof Error && error.message === "File already exists") throw error;
    }
  }
  await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  const info = await stat(target);
  return JSON.stringify({ path: displayWorkspacePath(root, target), sizeBytes: info.size, updatedAt: info.mtimeMs });
}

async function editWorkspaceFile(root: string, input: JsonObject): Promise<string> {
  const path = requiredString(input, "path");
  const oldText = requiredString(input, "old_text");
  const newText = typeof input.new_text === "string" ? input.new_text : "";
  const target = await workspacePath(root, path);
  const original = await readFile(target, "utf8");
  const matches = original.split(oldText).length - 1;
  if (!matches) throw new Error("old_text was not found");
  if (!input.replace_all && matches !== 1) throw new Error(`old_text occurs ${matches} times; set replace_all=true or provide more context`);
  const updated = input.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, newText);
  await writeFile(target, updated, "utf8");
  return JSON.stringify({ path: displayWorkspacePath(root, target), replacements: input.replace_all ? matches : 1, sizeBytes: Buffer.byteLength(updated) });
}

async function globWorkspace(root: string, pattern: string): Promise<string> {
  const workspacePattern = normalizeWorkspaceInput(pattern);
  if (isAbsolute(workspacePattern) || workspacePattern.split("/").includes("..")) throw new Error("Glob must be relative to /workspace");
  if (workspacePattern === ".") return JSON.stringify(["."]);
  const matches: string[] = [];
  for await (const item of glob(workspacePattern, { cwd: root, withFileTypes: true, exclude: ["**/node_modules/**", "**/.git/**"] })) {
    matches.push(displayWorkspacePath(root, resolve(item.parentPath, item.name)));
    if (matches.length >= 1_000) break;
  }
  return JSON.stringify(matches);
}

async function grepWorkspace(root: string, input: JsonObject): Promise<string> {
  const query = requiredString(input, "query");
  const pattern = normalizeWorkspaceInput(optionalString(input, "pattern") || "**/*");
  if (isAbsolute(pattern) || pattern.split("/").includes("..")) throw new Error("Glob must be relative to /workspace");
  const matcher = input.regex ? new RegExp(query, "i") : null;
  const results: Array<{ path: string; line: number; text: string }> = [];
  for await (const item of glob(pattern, { cwd: root, withFileTypes: true, exclude: ["**/node_modules/**", "**/.git/**"] })) {
    if (!item.isFile()) continue;
    const path = resolve(item.parentPath, item.name);
    const canonical = await realpath(path);
    const canonicalRoot = await realpath(root);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) continue;
    const info = await stat(path);
    if (info.size > 1024 * 1024) continue;
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (matcher ? matcher.test(line) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
        results.push({ path: displayWorkspacePath(root, path), line: index + 1, text: line.slice(0, 500) });
        if (results.length >= 200) return JSON.stringify(results);
      }
      if (matcher?.global) matcher.lastIndex = 0;
    }
  }
  return JSON.stringify(results);
}

async function runShell(root: string, input: JsonObject, signal: AbortSignal): Promise<string> {
  const cwd = await workspacePath(root, optionalString(input, "cwd") ?? ".");
  const timeout = optionalInteger(input, "timeout", 30, 1, 120) * 1_000;
  return executeShell(requiredString(input, "command"), cwd, timeout, signal);
}

interface SkillMetadata { name: string; description: string; directory: string; }
async function listSkills(root: string): Promise<SkillMetadata[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: SkillMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = resolve(root, entry.name, "SKILL.md");
    try {
      const content = await readFile(file, "utf8");
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
      const name = frontmatter?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.name;
      const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      result.push({ name, description, directory: resolve(root, entry.name) });
    } catch { /* Not a valid skill directory. */ }
  }
  return result;
}

async function useSkill(root: string, skills: SkillMetadata[], input: JsonObject): Promise<string> {
  const skill = skills.find((item) => item.name === requiredString(input, "name"));
  if (!skill) throw new Error("Skill is not available");
  const relativePath = optionalString(input, "path") ?? "SKILL.md";
  const target = resolve(skill.directory, relativePath);
  if (target !== skill.directory && !target.startsWith(`${skill.directory}${sep}`)) throw new Error("Skill path escapes its directory");
  const canonical = await realpath(target);
  if (!canonical.startsWith(`${await realpath(root)}${sep}`)) throw new Error("Skill path resolves outside the skills directory");
  return readFile(canonical, "utf8");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
