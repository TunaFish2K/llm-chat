import type {
  AgentSummaryDto,
  AppSettings,
  ConnectionDto,
  ConversationDto,
  GenerationDto,
  MessageDto,
  ModelDto
} from "@llm-chat/contracts";
import { api, endpoints, onAuthRequired } from "./api";
import { cancelGenerationHaptic, scheduleGenerationHaptic } from "./haptics";
import { createStore } from "./store";
import { subscribeAppEvents, subscribeGeneration, type Subscription } from "./sse";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export interface AppState {
  auth: "loading" | "required" | "ready";
  bootError: string | null;
  settings: AppSettings | null;
  agents: AgentSummaryDto[];
  connections: ConnectionDto[];
  models: ModelDto[];
  conversations: ConversationDto[];
  messages: Record<string, MessageDto[]>;
  toasts: Toast[];
  eventsConnected: boolean;
  runningTasksByConversation: Record<string, number>;
}

export const appStore = createStore<AppState>({
  auth: "loading",
  bootError: null,
  settings: null,
  agents: [],
  connections: [],
  models: [],
  conversations: [],
  messages: {},
  toasts: [],
  eventsConnected: false,
  runningTasksByConversation: {}
});

let toastSeq = 0;

export function toast(kind: Toast["kind"], text: string): void {
  const id = ++toastSeq;
  appStore.set((state) => ({ toasts: [...state.toasts.slice(-4), { id, kind, text }] }));
  setTimeout(() => {
    appStore.set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  }, 5_000);
}

export function toastError(error: unknown): void {
  toast("error", error instanceof Error ? error.message : String(error));
}

export async function bootstrap(conversationId?: string): Promise<void> {
  appStore.set({ auth: "loading", bootError: null });
  try {
    const data = await endpoints.bootstrap(conversationId);
    const normalizedMessages = data.messages ? normalizeMessages(data.messages) : undefined;
    const bootMessages = conversationId && normalizedMessages ? { [conversationId]: normalizedMessages } : {};
    appStore.set({
      auth: "ready",
      settings: data.settings,
      agents: data.agents,
      connections: data.connections,
      models: data.models,
      conversations: data.conversations,
      ...(conversationId && normalizedMessages ? { messages: bootMessages } : {})
    });
    if (conversationId && normalizedMessages) {
      for (const message of normalizedMessages) {
        for (const generation of message.generations) {
          if (isGenerationActive(generation.status)) trackGeneration(conversationId, message.id, generation.id);
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) {
      appStore.set({ auth: "required" });
      return;
    }
    appStore.set({ auth: "loading", bootError: error instanceof Error ? error.message : "加载失败" });
  }
}

export async function refreshConversations(): Promise<void> {
  const conversations = await endpoints.conversations();
  appStore.set({ conversations });
}

export async function refreshAgents(): Promise<void> {
  const agents = await endpoints.agents();
  appStore.set({ agents });
}

export async function refreshConnectionsAndModels(): Promise<void> {
  const [connections, models] = await Promise.all([endpoints.connections(), endpoints.models()]);
  appStore.set({ connections, models });
}

export async function refreshSettings(): Promise<void> {
  const settings = await endpoints.settings();
  appStore.set({ settings });
}

export async function loadMessages(conversationId: string): Promise<MessageDto[]> {
  const messages = normalizeMessages(await endpoints.messages(conversationId));
  appStore.set((state) => ({ messages: { ...state.messages, [conversationId]: messages } }));
  for (const message of messages) {
    for (const generation of message.generations) {
      if (isGenerationActive(generation.status)) trackGeneration(conversationId, message.id, generation.id);
    }
  }
  return messages;
}

function normalizeMessages(messages: MessageDto[]): MessageDto[] {
  return messages.map((message) => ({
    ...message,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    generations: Array.isArray(message.generations) ? message.generations : []
  }));
}

export function upsertMessage(conversationId: string, message: MessageDto): void {
  appStore.set((state) => {
    const list = state.messages[conversationId] ?? [];
    const index = list.findIndex((item) => item.id === message.id);
    const next = index >= 0 ? list.map((item, i) => (i === index ? message : item)) : [...list, message];
    return { messages: { ...state.messages, [conversationId]: next } };
  });
}

export function isGenerationActive(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting-approval";
}

const generationStreams = new Map<string, Subscription>();
const generationOwners = new Map<string, { conversationId: string; messageId: string }>();

export function trackGeneration(conversationId: string, messageId: string, generationId: string): void {
  generationOwners.set(generationId, { conversationId, messageId });
  ensureGenerationStream(generationId);
}

export function ensureGenerationStream(generationId: string): void {
  if (generationStreams.has(generationId)) return;
  const subscription = subscribeGeneration(
    generationId,
    (event) => {
      void handleGenerationEvent(generationId, event);
    },
    () => {
      // Reconnecting; on reconnect the snapshot event re-syncs state.
    }
  );
  generationStreams.set(generationId, subscription);
}

async function handleGenerationEvent(
  generationId: string,
  event: import("@llm-chat/contracts").GenerationEvent
): Promise<void> {
  const owner = generationOwners.get(generationId);
  if (!owner) {
    if (event.type === "snapshot") {
      generationOwners.set(generationId, { conversationId: "", messageId: "" });
    }
    return;
  }
  if (event.type === "snapshot") {
    applyGeneration(owner.conversationId, owner.messageId, event.generation);
    if (!isGenerationActive(event.generation.status)) closeGenerationStream(generationId);
    return;
  }
  const message = findMessage(owner.conversationId, owner.messageId);
  const generation = message?.generations.find((item) => item.id === generationId);
  if (!message || !generation) return;
  const next: GenerationDto = { ...generation };
  if (event.type === "block-delta") {
    const blocks = [...next.blocks];
    const index = blocks.findIndex((block) => block.id === event.block.id);
    if (index >= 0) blocks[index] = event.block;
    else blocks.push(event.block);
    blocks.sort((a, b) => a.index - b.index);
    next.blocks = blocks;
    scheduleGenerationHaptic();
  } else if (event.type === "usage") {
    next.usage = event.usage;
  } else if (event.type === "tool-call") {
    const calls = [...next.toolCalls];
    const index = calls.findIndex((call) => call.id === event.toolCall.id);
    if (index >= 0) calls[index] = event.toolCall;
    else calls.push(event.toolCall);
    calls.sort((a, b) => a.index - b.index);
    next.toolCalls = calls;
  } else if (event.type === "vision-analysis") {
    const analyses = [...next.visionAnalyses];
    const index = analyses.findIndex((analysis) => analysis.id === event.analysis.id);
    if (index >= 0) analyses[index] = event.analysis;
    else analyses.push(event.analysis);
    next.visionAnalyses = analyses;
  } else if (event.type === "status") {
    next.status = event.status;
    if (event.stopReason !== undefined) next.stopReason = event.stopReason;
    if (!isGenerationActive(event.status)) cancelGenerationHaptic();
  } else if (event.type === "error") {
    next.status = "failed";
    next.error = { code: event.code, message: event.message };
    cancelGenerationHaptic();
  }
  applyGeneration(owner.conversationId, owner.messageId, next);
  if (event.type === "status" && !isGenerationActive(event.status)) {
    closeGenerationStream(generationId);
    // Final status may update message-level fields; re-sync from the server.
    try {
      await loadMessages(owner.conversationId);
    } catch {
      /* ignore */
    }
  }
  if (event.type === "error") {
    closeGenerationStream(generationId);
  }
}

function closeGenerationStream(generationId: string): void {
  generationStreams.get(generationId)?.close();
  generationStreams.delete(generationId);
}

function findMessage(conversationId: string, messageId: string): MessageDto | undefined {
  return appStore.get().messages[conversationId]?.find((item) => item.id === messageId);
}

function applyGeneration(conversationId: string, messageId: string, generation: GenerationDto): void {
  appStore.set((state) => {
    const list = state.messages[conversationId];
    if (!list) return {};
    return {
      messages: {
        ...state.messages,
        [conversationId]: list.map((message) =>
          message.id === messageId
            ? {
                ...message,
                generations: message.generations.map((item) => (item.id === generation.id ? generation : item))
              }
            : message
        )
      }
    };
  });
}

let appEventsSubscription: Subscription | null = null;

export function startAppEvents(): void {
  if (appEventsSubscription) return;
  appEventsSubscription = subscribeAppEvents(
    (event) => {
      if (event.type === "task") {
        void refreshTaskCounts();
      }
    },
    (connected) => appStore.set({ eventsConnected: connected })
  );
}

export async function refreshTaskCounts(): Promise<void> {
  try {
    const tasks = await api.get<Array<{ conversationId: string; status: string }>>("/api/background-tasks?scope=all");
    const runningTasksByConversation: Record<string, number> = {};
    for (const task of tasks) {
      if (!["queued", "starting", "running"].includes(task.status)) continue;
      runningTasksByConversation[task.conversationId] = (runningTasksByConversation[task.conversationId] ?? 0) + 1;
    }
    appStore.set({ runningTasksByConversation });
  } catch {
    /* ignore */
  }
}

export function initAuthGate(): void {
  onAuthRequired(() => {
    appStore.set({ auth: "required" });
  });
}
