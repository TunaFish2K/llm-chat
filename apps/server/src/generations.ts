import type { GenerationEvent, GenerationStatus, ProviderProtocol, UsageDto } from "@llm-chat/contracts";
import Ajv, { type ValidateFunction } from "ajv";
import {
  adapterFor,
  ProviderError,
  type GenerateRequest,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderMessage
} from "@llm-chat/providers";
import { buildContext, ContextError, type BuiltContext } from "./context";
import { StoreError, type GenerationRecord, type Store } from "./database";
import { createSearchToolsTool, SEARCH_TOOLS_NAME } from "./tool-registry";
import { buildServerTools, persistLargeToolOutput, toolSystemPrompt, type ServerTool } from "./tools";
import type { PreparedImages } from "./vision";
import { providerRequestContext } from "./provider-context";
import type { ImageService } from "./images";
import { ShellError } from "./shell";

type Subscriber = (event: GenerationEvent) => void;
const schemaValidator = new Ajv({ allErrors: true, strict: false });
const toolValidators = new WeakMap<ServerTool, ValidateFunction>();

interface LiveJob {
  detached?: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  subscribers: Set<Subscriber>;
  conversationId: string;
  latestBlocks: Map<number, Extract<GenerationEvent, { type: "block-delta" }>>;
}

export interface GenerationRunnerDependencies {
  onSettled?: (conversationId: string) => void;
  buildContext: (
    store: Store,
    record: Parameters<typeof buildContext>[1],
    model: Parameters<typeof buildContext>[2],
    connection: ProviderConnection,
    signal: AbortSignal,
    preparedImages?: PreparedImages
  ) => Promise<BuiltContext>;
  prepareImages: (
    store: Store,
    record: GenerationRecord,
    model: Parameters<typeof buildContext>[2],
    signal: AbortSignal,
    onAnalysis: (analysis: import("@llm-chat/contracts").VisionAnalysisDto) => void
  ) => Promise<PreparedImages>;
  buildTools: (store: Store, record: GenerationRecord) => Promise<ServerTool[]>;
  memoryPrompt: (store: Store) => string;
  runtimePrompt: (store: Store, record: GenerationRecord) => string;
  stream: (protocol: ProviderProtocol, request: GenerateRequest) => AsyncIterable<ProviderEvent>;
  persistToolOutput: (store: Store, callId: string, output: string) => Promise<string>;
  imageService?: ImageService;
}

const defaultDependencies: GenerationRunnerDependencies = {
  buildContext,
  prepareImages: async () => new Map(),
  buildTools: (store, record) => buildServerTools(store, false, {
    workspacePath: record.agentSnapshot.workspacePath
  }),
  memoryPrompt: toolSystemPrompt,
  runtimePrompt: () => "",
  stream: (protocol, request) => adapterFor(protocol).stream(request),
  persistToolOutput: persistLargeToolOutput
};

export class GenerationRunner {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly jobPromises = new Set<Promise<void>>();
  private readonly dependencies: GenerationRunnerDependencies;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly store: Store, dependencies: Partial<GenerationRunnerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  isConversationActive(conversationId: string): boolean {
    return [...this.jobs.values()].some((job) => job.conversationId === conversationId);
  }

  start(generationId: string): void {
    if (this.closing) throw new Error("Generation runner is closing");
    if (this.jobs.has(generationId)) return;
    const record = this.store.getGenerationRecord(generationId);
    if (!record) throw new Error("Generation not found");
    if (record.status !== "queued" && record.status !== "waiting-approval") return;
    const job: LiveJob = {
      controller: new AbortController(),
      subscribers: new Set(),
      conversationId: record.conversationId,
      latestBlocks: new Map()
    };
    this.jobs.set(generationId, job);
    let jobPromise: Promise<void>;
    jobPromise = this.run(generationId, job).finally(() => {
      // Terminal state has already been persisted and emitted by run();
      // late SSE subscribers recover from the database snapshot instead,
      // so the job can be removed immediately (busy checks must not see
      // finished generations as active).
      if (job.cancelTimer) clearTimeout(job.cancelTimer);
      this.jobs.delete(generationId);
      this.jobPromises.delete(jobPromise);
      if (!this.closing && !job.detached) this.dependencies.onSettled?.(job.conversationId);
    });
    this.jobPromises.add(jobPromise);
    void jobPromise.catch(() => {});
  }

  subscribe(generationId: string, subscriber: Subscriber): () => void {
    const job = this.jobs.get(generationId);
    if (!job) return () => {};
    job.subscribers.add(subscriber);
    for (const event of [...job.latestBlocks.values()].sort((a, b) => a.block.index - b.block.index)) {
      subscriber(event);
    }
    return () => job.subscribers.delete(subscriber);
  }

  cancel(generationId: string): boolean {
    const job = this.jobs.get(generationId);
    if (job) {
      if (job.controller.signal.aborted) return true;
      job.controller.abort();
      job.cancelTimer = setTimeout(() => {
        job.detached = true;
        this.store.finishGeneration(generationId, "stopped", { stopReason: "cancelled" });
        this.emitStatus(generationId, "stopped", "cancelled");
        this.jobs.delete(generationId);
        if (!this.closing) this.dependencies.onSettled?.(job.conversationId);
      }, 2000);
      return true;
    }
    const record = this.store.getGenerationRecord(generationId);
    if (record?.status !== "waiting-approval" && record?.status !== "queued") return false;
    for (const call of this.store.listToolCalls(generationId).filter((item) => item.approvalState === "pending")) {
      this.store.updateToolCall(call.id, {
        approvalState: "denied",
        output: JSON.stringify({ error: "Generation cancelled before tool execution" }),
        completedAt: Date.now()
      });
    }
    this.store.finishGeneration(generationId, "stopped", { stopReason: "cancelled" });
    if (!this.closing) this.dependencies.onSettled?.(record.conversationId);
    return true;
  }

  stopAll(): void {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stopAll();
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2100);
      void Promise.allSettled([...this.jobPromises]).then(() => { clearTimeout(timer); resolve(); });
    });
    return this.closePromise;
  }

  private emit(generationId: string, event: GenerationEvent): void {
    for (const subscriber of this.jobs.get(generationId)?.subscribers ?? []) subscriber(event);
  }

  private async run(generationId: string, job: LiveJob): Promise<void> {
    const record = this.store.getGenerationRecord(generationId);
    if (!record) return;
    const model = this.store.getModel(record.modelId);
    const secretConnection = this.store.getConnection(record.connectionId);
    if (!model || !secretConnection) {
      this.fail(generationId, "configuration_missing", "模型或连接已被删除");
      return;
    }
    const connection: ProviderConnection = {
      id: secretConnection.id,
      providerId: secretConnection.providerId,
      protocol: secretConnection.protocol,
      baseUrl: secretConnection.baseUrl,
      apiKey: secretConnection.apiKey,
      secretHeaders: secretConnection.secretHeaders
    };
    const resuming = record.status === "waiting-approval";
    this.store.setGenerationRunning(generationId);
    this.emitStatus(generationId, "running");
    const pendingBlocks = new Map<number, {
      type: "text" | "reasoning" | "refusal" | "unsupported";
      content: string;
      complete: boolean;
      providerPayload?: unknown;
    }>();
    let flushTimer: NodeJS.Timeout | undefined;
    let generatedImageIndex = 0;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (job.detached) { pendingBlocks.clear(); return; }
      for (const [index, block] of pendingBlocks) {
        this.store.updateGenerationBlock(
          generationId,
          index,
          block.type,
          block.content,
          block.complete,
          block.providerPayload
        );
      }
      pendingBlocks.clear();
    };
    const scheduleFlush = () => {
      flushTimer ??= setTimeout(flush, 250);
    };

    try {
      const preparedImages = await this.dependencies.prepareImages(
        this.store,
        record,
        model,
        job.controller.signal,
        (analysis) => this.emit(generationId, { type: "vision-analysis", generationId, analysis })
      );
      job.controller.signal.throwIfAborted();
      const context = await this.dependencies.buildContext(
        this.store,
        record,
        model,
        connection,
        job.controller.signal,
        preparedImages
      );
      job.controller.signal.throwIfAborted();
      this.store.setGenerationContext(generationId, context.metadata);
      const toolPolicy = record.agentSnapshot.execution.tools;
      const authorizedTools = model.capabilities.tools
        ? (await this.dependencies.buildTools(this.store, record)).filter((tool) =>
            tool.available && tool.definition.name !== SEARCH_TOOLS_NAME
            && (toolPolicy.overrides[tool.definition.name] ?? toolPolicy.defaultEnabled))
        : [];
      job.controller.signal.throwIfAborted();
      const authorizedToolMap = new Map(authorizedTools.map((tool) => [tool.definition.name, tool]));
      const lazyTools = authorizedTools.filter((tool) => (toolPolicy.directOverrides?.[tool.definition.name] ?? true) === false);
      const exposedToolNames = new Set(authorizedTools
        .filter((tool) => (toolPolicy.directOverrides?.[tool.definition.name] ?? true) !== false)
        .map((tool) => tool.definition.name));
      const exposeAuthorized = (names: string[]) => {
        for (const name of names) if (authorizedToolMap.has(name)) exposedToolNames.add(name);
      };
      const searchTool = lazyTools.length ? createSearchToolsTool(lazyTools) : undefined;
      const exposedToolMap = (): Map<string, ServerTool> => new Map([
        ...[...exposedToolNames].map((name) => [name, authorizedToolMap.get(name)!] as const),
        ...(searchTool ? [[SEARCH_TOOLS_NAME, searchTool] as const] : [])
      ]);
      const memoryPrompt = this.dependencies.memoryPrompt(this.store);
      let messages: ProviderMessage[] = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      let usage = cleanUsage(this.store.getGeneration(generationId)?.usage ?? {});
      const existingCalls = this.store.listToolCalls(generationId);
      await restoreExposedTools(existingCalls, authorizedToolMap, exposeAuthorized);
      job.controller.signal.throwIfAborted();
      let stepIndex = nextStepIndex(existingCalls);

      if (resuming) {
        const existing = this.store.listToolCalls(generationId);
        if (existing.some((call) => call.approvalState === "pending")) {
          this.waitForApproval(generationId);
          return;
        }
        const executable = existing.filter((call) =>
          call.output === null && call.error === null
          && (call.approvalState === "auto" || call.approvalState === "approved" || call.approvalState === "denied")
        );
        await this.executeTools(record, executable, exposedToolMap(), exposeAuthorized, job.controller.signal);
        job.controller.signal.throwIfAborted();
        messages = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      }

      const maxToolRounds = record.agentSnapshot.execution.maxToolRounds;
      for (; maxToolRounds === null || stepIndex < maxToolRounds; stepIndex += 1) {
        job.controller.signal.throwIfAborted();
        const stepToolMap = exposedToolMap();
        const calls: Array<{ id: string; name: string; arguments: string }> = [];
        let providerContext: unknown;
        let stopReason = "stop";
        let stepUsage: UsageDto = {};
        const systemPrompt = [context.systemPrompt, memoryPrompt, this.dependencies.runtimePrompt(this.store, record)]
          .filter(Boolean).join("\n\n");
        for await (const event of this.dependencies.stream(record.protocol, {
          connection,
          modelKey: record.modelKey,
          systemPrompt,
          postHistoryInstructions: context.postHistoryInstructions ?? "",
          messages,
          tools: [...stepToolMap.values()].map((tool) => tool.definition),
          settings: record.settings,
          capabilities: model.capabilities,
          requestContext: providerRequestContext(record, `step-${stepIndex}`),
          signal: job.controller.signal
        })) {
          job.controller.signal.throwIfAborted();
          if (event.type === "block") {
            const blockIndex = stepIndex * 1000 + event.index;
            pendingBlocks.set(blockIndex, {
              type: event.blockType,
              content: event.content,
              complete: event.complete,
              ...(event.providerPayload !== undefined ? { providerPayload: event.providerPayload } : {})
            });
            const delta: Extract<GenerationEvent, { type: "block-delta" }> = {
              type: "block-delta",
              generationId,
              block: {
                id: `${generationId}:${blockIndex}`,
                index: blockIndex,
                stepIndex,
                type: event.blockType,
                content: event.content,
                complete: event.complete
              }
            };
            job.latestBlocks.set(blockIndex, delta);
            this.emit(generationId, delta);
            scheduleFlush();
          } else if (event.type === "tool-call") {
            calls.push(event.call);
          } else if (event.type === "image") {
            if (!this.dependencies.imageService) throw new Error("图片服务不可用");
            const asset = await this.dependencies.imageService.importGeneratedBytes(
              `${record.modelKey}-response-${++generatedImageIndex}`,
              Buffer.from(event.dataBase64, "base64")
            );
            job.controller.signal.throwIfAborted();
            this.store.attachImagesToMessage(record.assistantMessageId, [asset.id]);
          } else if (event.type === "provider-context") {
            providerContext = event.payload;
          } else if (event.type === "usage") {
            stepUsage = cleanUsage(event.usage);
            this.emit(generationId, { type: "usage", generationId, usage: addUsage(usage, stepUsage) });
          } else if (event.type === "complete") {
            stopReason = event.stopReason;
          }
        }
        job.controller.signal.throwIfAborted();
        flush();
        usage = addUsage(usage, stepUsage);
        this.store.updateGenerationUsage(generationId, usage);
        if (providerContext !== undefined) {
          this.store.setProviderContext(generationId, providerContext);
          this.store.setGenerationStepContext(generationId, stepIndex, providerContext);
        }
        if (!calls.length) {
          job.controller.signal.throwIfAborted();
          this.store.finishGeneration(generationId, "completed", { stopReason });
          this.emitStatus(generationId, "completed", stopReason);
          return;
        }

        const persisted = [];
        for (const [index, call] of calls.entries()) {
          const definition = stepToolMap.get(call.name);
          const args = parseToolArguments(call.arguments);
          if (definition) validateToolArguments(definition, args);
          const override = !definition || call.name === SEARCH_TOOLS_NAME
            ? "never"
            : toolPolicy.approvalOverrides[call.name] ?? "default";
          const requiresApproval = override === "always"
            || (override === "default" && await (definition?.requiresApproval(args) ?? false));
          job.controller.signal.throwIfAborted();
          const saved = this.store.upsertToolCall(generationId, call, stepIndex * 1000 + index, stepIndex, requiresApproval);
          this.emit(generationId, { type: "tool-call", generationId, toolCall: saved });
          persisted.push(saved);
        }
        if (persisted.some((call) => call.approvalState === "pending")) {
          job.controller.signal.throwIfAborted();
          this.waitForApproval(generationId);
          return;
        }
        await this.executeTools(record, persisted, stepToolMap, exposeAuthorized, job.controller.signal);
        job.controller.signal.throwIfAborted();
        messages = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      }
      throw new Error(`Tool execution exceeded the Agent limit of ${maxToolRounds} model steps`);
    } catch (error) {
      if (job.detached) return;
      flush();
      if (job.controller.signal.aborted) {
        this.store.finishGeneration(generationId, "stopped", { stopReason: "cancelled" });
        this.emitStatus(generationId, "stopped", "cancelled");
        return;
      }
      const normalized = normalizeError(error);
      this.fail(generationId, normalized.code, normalized.message);
    }
  }

  private waitForApproval(generationId: string): void {
    this.store.setGenerationWaitingApproval(generationId);
    this.emitStatus(generationId, "waiting-approval", "tool_approval");
  }

  private async executeTools(
    record: GenerationRecord,
    calls: ReturnType<Store["listToolCalls"]>,
    toolMap: Map<string, ServerTool>,
    exposeAuthorized: (names: string[]) => void,
    signal: AbortSignal
  ): Promise<void> {
    const generationId = record.id;
    for (const call of calls) {
      signal.throwIfAborted();
      if (call.approvalState === "denied") {
        const updated = this.store.updateToolCall(call.id, {
          output: JSON.stringify({ error: "Tool execution denied by user" }),
          completedAt: Date.now()
        })!;
        this.emit(generationId, { type: "tool-call", generationId, toolCall: updated });
        continue;
      }
      const tool = toolMap.get(call.name);
      const running = this.store.updateToolCall(call.id, { approvalState: "running", startedAt: Date.now() })!;
      this.emit(generationId, { type: "tool-call", generationId, toolCall: running });
      try {
        if (!tool) throw new Error(`Tool ${call.name} is not available`);
        const rawOutput = await tool.execute(parseToolArguments(call.arguments), signal, {
          conversationId: record.conversationId, generationId, toolCallId: call.id, snapshot: record.agentSnapshot
        });
        signal.throwIfAborted();
        const output = await this.dependencies.persistToolOutput(
          this.store,
          call.id,
          rawOutput
        );
        signal.throwIfAborted();
        const completed = this.store.updateToolCall(call.id, {
          approvalState: "completed", output, error: null, completedAt: Date.now()
        })!;
        this.emit(generationId, { type: "tool-call", generationId, toolCall: completed });
        if (tool.activatesTools) exposeAuthorized(await tool.activatesTools(parseToolArguments(call.arguments)));
      } catch (error) {
        if (signal.aborted && !(error instanceof ShellError)) throw error;
        if (!this.jobs.has(generationId)) throw error;
        const message = error instanceof Error ? error.message : "Tool execution failed";
        const rawError = JSON.stringify({ error: message, ...(error instanceof ShellError ? error.result : {}) });
        const output = await this.dependencies.persistToolOutput(this.store, call.id, rawError).catch(() => JSON.stringify({
          error: message.slice(0, 4096), ...(error instanceof ShellError ? {
            ...error.result, stdout: error.result.stdout.slice(-4096), stderr: error.result.stderr.slice(-4096), truncated: true
          } : {})
        }));
        if (!this.jobs.has(generationId)) throw error;
        const failed = this.store.updateToolCall(call.id, {
          approvalState: "failed",
          error: message,
          output,
          completedAt: Date.now()
        })!;
        this.emit(generationId, { type: "tool-call", generationId, toolCall: failed });
        if (signal.aborted) throw error;
      }
    }
  }

  private fail(generationId: string, code: string, message: string): void {
    this.store.finishGeneration(generationId, "failed", { code, message });
    this.emit(generationId, { type: "error", generationId, code, message });
    this.emitStatus(generationId, "failed");
  }

  private emitStatus(generationId: string, status: GenerationStatus, stopReason?: string): void {
    this.emit(generationId, {
      type: "status",
      generationId,
      status,
      ...(stopReason ? { stopReason } : {})
    });
  }
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError || error instanceof ContextError || error instanceof StoreError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "generation_failed", message: error.message };
  return { code: "generation_failed", message: "生成失败" };
}

function cleanUsage(usage: UsageDto): UsageDto {
  const result = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined)
  ) as UsageDto;
  if (
    result.totalTokens === undefined
    && (result.inputTokens !== undefined || result.outputTokens !== undefined)
  ) {
    result.totalTokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  }
  return result;
}

function addUsage(current: UsageDto, next: UsageDto): UsageDto {
  const normalizedCurrent = cleanUsage(current);
  const normalizedNext = cleanUsage(next);
  const result: UsageDto = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "totalTokens"] as const) {
    if (normalizedCurrent[key] !== undefined || normalizedNext[key] !== undefined) {
      result[key] = (normalizedCurrent[key] ?? 0) + (normalizedNext[key] ?? 0);
    }
  }
  return result;
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateToolArguments(tool: ServerTool, input: Record<string, unknown>): void {
  let validate = toolValidators.get(tool);
  if (!validate) {
    validate = schemaValidator.compile(tool.definition.inputSchema);
    toolValidators.set(tool, validate);
  }
  if (!validate(input)) throw new Error(`Invalid tool arguments for ${tool.definition.name}: ${schemaValidator.errorsText(validate.errors)}`);
}

function nextStepIndex(calls: ReturnType<Store["listToolCalls"]>): number {
  if (!calls.length) return 0;
  return Math.floor(Math.max(...calls.map((call) => call.index)) / 1000) + 1;
}

async function restoreExposedTools(
  calls: ReturnType<Store["listToolCalls"]>,
  authorizedTools: Map<string, ServerTool>,
  exposeAuthorized: (names: string[]) => void
): Promise<void> {
  for (const call of calls) {
    if (call.approvalState !== "completed" || call.output === null) continue;
    if (call.name === SEARCH_TOOLS_NAME) {
      try {
        const parsed = JSON.parse(call.output) as { loadedToolNames?: unknown };
        if (Array.isArray(parsed.loadedToolNames)) {
          exposeAuthorized(parsed.loadedToolNames.filter((name): name is string => typeof name === "string"));
        }
      } catch {
        // A malformed historical meta-tool result grants no tool exposure.
      }
      continue;
    }
    const tool = authorizedTools.get(call.name);
    if (!tool?.activatesTools) continue;
    try {
      exposeAuthorized(await tool.activatesTools(parseToolArguments(call.arguments)));
    } catch {
      // Missing historical activation metadata must not broaden authority.
    }
  }
}
