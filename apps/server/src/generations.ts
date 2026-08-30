import type { GenerationEvent, GenerationStatus, ProviderProtocol, UsageDto } from "@llm-chat/contracts";
import {
  adapterFor,
  ProviderError,
  type GenerateRequest,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderMessage
} from "@llm-chat/providers";
import { buildContext, ContextError, type BuiltContext } from "./context";
import type { Store } from "./database";
import { buildServerTools, persistLargeToolOutput, toolSystemPrompt, type ServerTool } from "./tools";

type Subscriber = (event: GenerationEvent) => void;

interface LiveJob {
  controller: AbortController;
  subscribers: Set<Subscriber>;
  conversationId: string;
  latestBlocks: Map<number, Extract<GenerationEvent, { type: "block-delta" }>>;
}

export interface GenerationRunnerDependencies {
  buildContext: (
    store: Store,
    record: Parameters<typeof buildContext>[1],
    model: Parameters<typeof buildContext>[2],
    connection: ProviderConnection,
    signal: AbortSignal
  ) => Promise<BuiltContext>;
  buildTools: (store: Store) => Promise<ServerTool[]>;
  memoryPrompt: (store: Store) => string;
  stream: (protocol: ProviderProtocol, request: GenerateRequest) => AsyncIterable<ProviderEvent>;
  persistToolOutput: (store: Store, callId: string, output: string) => Promise<string>;
}

const defaultDependencies: GenerationRunnerDependencies = {
  buildContext,
  buildTools: buildServerTools,
  memoryPrompt: toolSystemPrompt,
  stream: (protocol, request) => adapterFor(protocol).stream(request),
  persistToolOutput: persistLargeToolOutput
};

export class GenerationRunner {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly dependencies: GenerationRunnerDependencies;

  constructor(private readonly store: Store, dependencies: Partial<GenerationRunnerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  isConversationActive(conversationId: string): boolean {
    return [...this.jobs.values()].some((job) => job.conversationId === conversationId);
  }

  start(generationId: string): void {
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
    void this.run(generationId, job).finally(() => {
      // Terminal state has already been persisted and emitted by run();
      // late SSE subscribers recover from the database snapshot instead,
      // so the job can be removed immediately (busy checks must not see
      // finished generations as active).
      this.jobs.delete(generationId);
    });
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
      job.controller.abort();
      return true;
    }
    const record = this.store.getGenerationRecord(generationId);
    if (record?.status !== "waiting-approval") return false;
    for (const call of this.store.listToolCalls(generationId).filter((item) => item.approvalState === "pending")) {
      this.store.updateToolCall(call.id, {
        approvalState: "denied",
        output: JSON.stringify({ error: "Generation cancelled before tool execution" }),
        completedAt: Date.now()
      });
    }
    this.store.finishGeneration(generationId, "stopped", { stopReason: "cancelled" });
    return true;
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
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
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
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
      const context = await this.dependencies.buildContext(this.store, record, model, connection, job.controller.signal);
      this.store.setGenerationContext(generationId, context.metadata);
      const toolPolicy = record.agentSnapshot.execution.tools;
      const tools = model.capabilities.tools
        ? (await this.dependencies.buildTools(this.store)).filter((tool) =>
            tool.available && (toolPolicy.overrides[tool.definition.name] ?? toolPolicy.defaultEnabled))
        : [];
      const toolMap = new Map(tools.map((tool) => [tool.definition.name, tool]));
      const memoryPrompt = this.dependencies.memoryPrompt(this.store);
      const systemPrompt = [context.systemPrompt, memoryPrompt].filter(Boolean).join("\n\n");
      let messages: ProviderMessage[] = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      let usage = this.store.getGeneration(generationId)?.usage ?? {};
      let stepIndex = nextStepIndex(this.store.listToolCalls(generationId));

      if (resuming) {
        const existing = this.store.listToolCalls(generationId);
        if (existing.some((call) => call.approvalState === "pending")) {
          this.waitForApproval(generationId);
          return;
        }
        const executable = existing.filter((call) =>
          call.output === null && call.error === null && (call.approvalState === "approved" || call.approvalState === "denied")
        );
        await this.executeTools(generationId, executable, toolMap, job.controller.signal);
        messages = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      }

      for (; stepIndex < 8; stepIndex += 1) {
        job.controller.signal.throwIfAborted();
        const calls: Array<{ id: string; name: string; arguments: string }> = [];
        let providerContext: unknown;
        let stopReason = "stop";
        let stepUsage: UsageDto = {};
        for await (const event of this.dependencies.stream(record.protocol, {
          connection,
          modelKey: record.modelKey,
          systemPrompt,
          postHistoryInstructions: context.postHistoryInstructions ?? "",
          messages,
          tools: tools.map((tool) => tool.definition),
          settings: record.settings,
          capabilities: model.capabilities,
          signal: job.controller.signal
        })) {
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
          } else if (event.type === "provider-context") {
            providerContext = event.payload;
          } else if (event.type === "usage") {
            stepUsage = cleanUsage(event.usage);
            this.emit(generationId, { type: "usage", generationId, usage: addUsage(usage, stepUsage) });
          } else if (event.type === "complete") {
            stopReason = event.stopReason;
          }
        }
        flush();
        usage = addUsage(usage, stepUsage);
        this.store.updateGenerationUsage(generationId, usage);
        if (providerContext !== undefined) {
          this.store.setProviderContext(generationId, providerContext);
          this.store.setGenerationStepContext(generationId, stepIndex, providerContext);
        }
        if (!calls.length) {
          this.store.finishGeneration(generationId, "completed", { stopReason });
          this.emitStatus(generationId, "completed", stopReason);
          return;
        }

        const persisted = calls.map((call, index) => {
          const definition = toolMap.get(call.name);
          const args = parseToolArguments(call.arguments);
          const requiresApproval = definition?.requiresApproval(args) ?? false;
          const saved = this.store.upsertToolCall(generationId, call, stepIndex * 1000 + index, stepIndex, requiresApproval);
          this.emit(generationId, { type: "tool-call", generationId, toolCall: saved });
          return saved;
        });
        if (persisted.some((call) => call.approvalState === "pending")) {
          this.waitForApproval(generationId);
          return;
        }
        await this.executeTools(generationId, persisted, toolMap, job.controller.signal);
        job.controller.signal.throwIfAborted();
        messages = [...context.messages, ...this.store.currentGenerationMessages(generationId)];
      }
      throw new Error("Tool execution exceeded the maximum of 8 model steps");
    } catch (error) {
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
    generationId: string,
    calls: ReturnType<Store["listToolCalls"]>,
    toolMap: Map<string, ServerTool>,
    signal: AbortSignal
  ): Promise<void> {
    for (const call of calls) {
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
        const output = await this.dependencies.persistToolOutput(
          this.store,
          call.id,
          await tool.execute(parseToolArguments(call.arguments), signal)
        );
        const completed = this.store.updateToolCall(call.id, {
          approvalState: "completed", output, error: null, completedAt: Date.now()
        })!;
        this.emit(generationId, { type: "tool-call", generationId, toolCall: completed });
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : "Tool execution failed";
        const failed = this.store.updateToolCall(call.id, {
          approvalState: "failed",
          error: message,
          output: JSON.stringify({ error: message }),
          completedAt: Date.now()
        })!;
        this.emit(generationId, { type: "tool-call", generationId, toolCall: failed });
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
  if (error instanceof ProviderError || error instanceof ContextError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: "generation_failed", message: error.message };
  return { code: "generation_failed", message: "生成失败" };
}

function cleanUsage(usage: UsageDto): UsageDto {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as UsageDto;
}

function addUsage(current: UsageDto, next: UsageDto): UsageDto {
  const result: UsageDto = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "totalTokens"] as const) {
    const value = (current[key] ?? 0) + (next[key] ?? 0);
    if (value) result[key] = value;
  }
  return cleanUsage(result);
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

function nextStepIndex(calls: ReturnType<Store["listToolCalls"]>): number {
  if (!calls.length) return 0;
  return Math.floor(Math.max(...calls.map((call) => call.index)) / 1000) + 1;
}
