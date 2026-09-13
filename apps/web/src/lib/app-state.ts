import { errorDisplayMessage } from "./error-display";
import { t, type DisplayMessage, localized } from "./i18n";
import { RefreshScheduler } from "./refresh-scheduler";
import { GenerationBlockBuffer } from "./generation-block-buffer";
import { initializeDisplayPreferences } from "./local-display";
import { observeNotificationEvent, startNotificationSession, stopNotificationSession } from "./notifications";
import { conversationDeleted, deletionRevision, markConversationsDeleted } from "./conversation-lifecycle";
import { preserveDeletedDraft, removeComposerDraft } from "./composer-drafts";
import { replaceRoute } from "./router";
import { resolveConversationRoot } from "./conversation-tree";
import { clearOfflineHistory, isOffline, offlineStore, persistOfflineMessages } from "./offline-history";
import type {
  AgentSummaryDto,
  AppSettings,
  ConnectionDto,
  ConversationDto,
  GenerationDto,
  MessageDto,
  ModelDto,
  FileAssetDto
} from "@llm-chat/contracts";
import { api, endpoints, onAuthRequired } from "./api";
import { cancelGenerationHaptic, scheduleGenerationHaptic } from "./haptics";
import { createStore } from "./store";
import { subscribeAppEvents, subscribeGeneration, type Subscription } from "./sse";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  i18n?: DisplayMessage["i18n"];
}

export type EventsConnectionState = "connecting" | "connected" | "reconnecting";

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
  eventsConnectionState: EventsConnectionState;
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
  eventsConnectionState: "connecting",
  runningTasksByConversation: {}
});

let toastSeq = 0;

export function toast(kind: Toast["kind"], value: string | DisplayMessage): void {
  const text = typeof value === "string" ? value : value.message;
  const i18n = typeof value === "string" ? undefined : value.i18n;
  const id = ++toastSeq;
  appStore.set((state) => ({ toasts: [...state.toasts.slice(-4), { id, kind, text, ...(i18n ? { i18n } : {}) }] }));
  setTimeout(() => {
    appStore.set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  }, 5_000);
}

export function toastError(error: unknown): void {
  if (error instanceof Error && "code" in error && ["conversation_not_found", "conversation_deleted_local"].includes(String(error.code))) return;
  if (isOffline() && error instanceof Error && /网络|联网|fetch|同步/.test(error.message)) return;
  toast("error", errorDisplayMessage(error));
}

export async function bootstrap(conversationId?: string, background = false): Promise<void> {
  if (!background) appStore.set({ auth: "loading", bootError: null });
  const session = messageSession;
  try {
    const knownIds = appStore.get().conversations.map((item) => item.id);
    const data = await endpoints.bootstrap(conversationId);
    if (session !== messageSession) return;
    if (!isOffline()) reconcileConversations(data.conversations, conversationId ?? null, knownIds);
    data.conversations = data.conversations.filter((item) => !conversationDeleted(item.id));
    if (conversationId && conversationDeleted(conversationId)) { delete data.messages; replaceRoute("/"); }
    initializeDisplayPreferences(data.settings);
    const normalizedMessages = data.messages ? normalizeMessages(data.messages) : undefined;
    const bootMessages = conversationId && normalizedMessages ? { [conversationId]: normalizedMessages } : {};
    appStore.set({
      auth: "ready",
      settings: data.settings,
      agents: data.agents,
      connections: data.connections,
      models: data.models,
      conversations: data.conversations,
      ...(conversationId && normalizedMessages ? { messages: retainedMessages({ ...appStore.get().messages, ...bootMessages }) } : {})
    });
    if (conversationId && normalizedMessages) {
      for (const message of normalizedMessages) {
        for (const generation of message.generations) {
          if (generating(generation.status)) trackGeneration(conversationId, message.id, generation.id);
        }
      }
    }
  } catch (error) {
    if (session !== messageSession) return;
    if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) {
      appStore.set({ auth: "required" });
      return;
    }
    if (!background) appStore.set({ auth: "loading", bootError: error instanceof Error ? error.message : t("SettingsView.could_not_load") });
  }
}

export function browseOfflineBranch(id: string): void {
  const conversations = appStore.get().conversations;
  const target = conversations.find((item) => item.id === id);
  if (!target) return;
  const root = resolveConversationRoot(target, conversations).id;
  appStore.set({ conversations: conversations.map((item) => resolveConversationRoot(item, conversations).id === root ? { ...item, activeBranchId: id } : item) });
}

let conversationsReadSequence = 0;
export function reconcileConversations(
  conversations: ConversationDto[],
  currentId: string | null = location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null,
  knownIds = appStore.get().conversations.map((item) => item.id)
): void {
  const ids = new Set(conversations.map((item) => item.id));
  const missing = knownIds.filter((id) => !ids.has(id));
  if (currentId && !ids.has(currentId)) missing.push(currentId);
  markConversationsDeleted(missing);
  if (currentId && conversationDeleted(currentId)) replaceRoute("/");
}
export async function refreshConversations(): Promise<void> {
  const session = messageSession;
  const sequence = ++conversationsReadSequence;
  const revision = deletionRevision();
  const knownIds = appStore.get().conversations.map((item) => item.id);
  const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
  const conversations = await endpoints.conversations();
  if (session !== messageSession || sequence !== conversationsReadSequence) return;
  if (!isOffline() && revision === deletionRevision()) reconcileConversations(conversations, currentId, knownIds);
  appStore.set({ conversations: conversations.filter((item) => !conversationDeleted(item.id)) });
}

export async function refreshAgents(): Promise<void> {
  const session = messageSession;
  const agents = await endpoints.agents();
  if (session !== messageSession) return;
  appStore.set({ agents });
}

export async function refreshConnectionsAndModels(): Promise<void> {
  const session = messageSession;
  const [connections, models] = await Promise.all([endpoints.connections(), endpoints.models()]);
  if (session !== messageSession) return;
  appStore.set({ connections, models });
}

let settingsReadSequence = 0;

export function acceptSettings(settings: AppSettings): void {
  initializeDisplayPreferences(settings);
  appStore.set({ settings });
}

export async function refreshSettings(): Promise<void> {
  const session = messageSession;
  const sequence = ++settingsReadSequence;
  const settings = await endpoints.settings();
  if (session === messageSession && sequence === settingsReadSequence) acceptSettings(settings);
}

const messageReads = new Map<string, Promise<MessageDto[]>>();
let messageSession = 0;
let eventsSession = 0;
const eventRefreshes = new RefreshScheduler(toastError);
const currentConversationId = () => location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
const generating = (status: string) => status === "queued" || status === "running";

function retainedMessages(messages: AppState["messages"]): AppState["messages"] {
  const current = currentConversationId();
  const active = new Set([...generationOwners.values()].map((owner) => owner.conversationId));
  return Object.fromEntries(Object.entries(messages).filter(([id, list]) => !conversationDeleted(id)
    && (id === current || active.has(id) || list.some((message) => message.generations.some((generation) => generating(generation.status))))));
}
export function releaseInactiveMessages(): void {
  const messages = appStore.get().messages;
  const retained = retainedMessages(messages);
  if (Object.keys(retained).length !== Object.keys(messages).length) appStore.set({ messages: retained });
}

export function loadMessages(conversationId: string): Promise<MessageDto[]> {
  if (conversationDeleted(conversationId)) return Promise.resolve([]);
  const existing = messageReads.get(conversationId);
  if (existing) return existing;
  const session = messageSession;
  const read = (async () => {
    const messages = normalizeMessages(await endpoints.messages(conversationId));
    if (session !== messageSession || conversationDeleted(conversationId)) return [];
    appStore.set((state) => ({ messages: retainedMessages({ ...state.messages, [conversationId]: messages }) }));
    persistOfflineMessages(conversationId, messages, true);
    for (const message of messages) {
      for (const generation of message.generations) {
        if (generating(generation.status)) trackGeneration(conversationId, message.id, generation.id);
      }
    }
    return messages;
  })().finally(() => { if (messageReads.get(conversationId) === read) messageReads.delete(conversationId); });
  messageReads.set(conversationId, read);
  return read;
}

export function refreshMessages(conversationId: string): void {
  if (conversationDeleted(conversationId)) return;
  const session = eventsSession;
  eventRefreshes.schedule(`messages:${conversationId}`, async () => {
    if (conversationId !== currentConversationId() && ![...generationOwners.values()].some((owner) => owner.conversationId === conversationId)) return;
    // A response begun before this event may be stale. Wait, then fetch once.
    await messageReads.get(conversationId)?.catch(() => {});
    if (session !== eventsSession) return;
    await loadMessages(conversationId);
  });
}

function normalizeMessages(messages: MessageDto[]): MessageDto[] {
  return messages.map((message, index) => ({
    ...message,
    ordinal: Number.isInteger(message.ordinal) ? message.ordinal : index + 1,
    attachments: Array.isArray(message.attachments) ? message.attachments.map(normalizeAsset) : [],
    generations: Array.isArray(message.generations) ? message.generations.map((generation) => ({
      ...generation,
      generationKind: generation.generationKind ?? "normal",
      toolCalls: Array.isArray(generation.toolCalls) ? generation.toolCalls.map((call) => ({
        ...call,
        artifacts: Array.isArray(call.artifacts) ? call.artifacts.map(normalizeAsset) : []
      })) : []
    })) : []
  }));
}

function normalizeAsset(asset: FileAssetDto): FileAssetDto {
  if (asset.kind === "image" || asset.kind === "file") return asset;
  return {
    ...asset,
    kind: asset.mimeType.startsWith("image/") ? "image" : "file"
  } as FileAssetDto;
}

export function upsertMessage(conversationId: string, message: MessageDto): void {
  if (conversationDeleted(conversationId)) return;
  const normalized = normalizeMessages([message])[0]!;
  appStore.set((state) => {
    const list = state.messages[conversationId] ?? [];
    const index = list.findIndex((item) => item.id === normalized.id);
    const next = index >= 0 ? list.map((item, i) => (i === index ? normalized : item)) : [...list, normalized];
    return { messages: retainedMessages({ ...state.messages, [conversationId]: next }) };
  });
}

export function isGenerationActive(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting-approval";
}

const generationStreams = new Map<string, Subscription>();
const generationOwners = new Map<string, { conversationId: string; messageId: string }>();
const generationBlocks = new GenerationBlockBuffer((generationId, blocks) => {
  const owner = generationOwners.get(generationId);
  if (!owner) return;
  const generation = findMessage(owner.conversationId, owner.messageId)?.generations.find((item) => item.id === generationId);
  if (!generation || !isGenerationActive(generation.status)) return;
  applyGeneration(owner.conversationId, owner.messageId, withBlocks(generation, blocks));
});

function withBlocks(generation: GenerationDto, updates: GenerationDto["blocks"]): GenerationDto {
  if (!updates.length) return generation;
  const blocks = new Map(generation.blocks.map((block) => [`${block.stepIndex}:${block.index}`, block]));
  let contentChanged = false;
  for (const block of updates) {
    const key = `${block.stepIndex}:${block.index}`;
    if ((blocks.get(key)?.content ?? "") !== block.content) contentChanged = true;
    blocks.set(key, block);
  }
  if (contentChanged && isGenerationActive(generation.status)) scheduleGenerationHaptic();
  return { ...generation, blocks: [...blocks.values()].sort((a, b) => a.index - b.index) };
}

export function trackGeneration(conversationId: string, messageId: string, generationId: string): void {
  if (conversationDeleted(conversationId)) return;
  generationOwners.set(generationId, { conversationId, messageId });
  ensureGenerationStream(generationId);
}

export function restartGenerationTracking(conversationId: string, messageId: string, generationId: string): void {
  closeGenerationStream(generationId);
  trackGeneration(conversationId, messageId, generationId);
}

export function ensureGenerationStream(generationId: string): void {
  if (isOffline()) return;
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
  if (!owner) { closeGenerationStream(generationId); return; }
  if (event.type === "snapshot") {
    generationBlocks.take(generationId);
    applyGeneration(owner.conversationId, owner.messageId, event.generation);
    if (generationStreamEnded(event.generation.status)) closeGenerationStream(generationId);
    return;
  }
  const message = findMessage(owner.conversationId, owner.messageId);
  const generation = message?.generations.find((item) => item.id === generationId);
  if (!message || !generation) {
    if ((event.type === "status" && generationStreamEnded(event.status)) || event.type === "error") closeGenerationStream(generationId);
    return;
  }
  if (event.type === "block-delta") {
    generationBlocks.push(generationId, event.block);
    return;
  }
  const next: GenerationDto = { ...withBlocks(generation, generationBlocks.take(generationId)) };
  if (event.type === "usage") {
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
    next.error = { code: event.code, message: event.message, ...(event.i18n ? { i18n: event.i18n } : {}) };
    cancelGenerationHaptic();
  }
  applyGeneration(owner.conversationId, owner.messageId, next);
  if (event.type === "status" && generationStreamEnded(event.status)) {
    closeGenerationStream(generationId);
    if (!isGenerationActive(event.status)) {
      // Final status may update message-level fields; re-sync from the server.
      if (owner.conversationId === currentConversationId()) refreshMessages(owner.conversationId);
    }
  }
  if (event.type === "error") {
    closeGenerationStream(generationId);
  }
}

function generationStreamEnded(status: string): boolean {
  return status === "waiting-approval" || !isGenerationActive(status);
}

function closeGenerationStream(generationId: string): void {
  generationBlocks.take(generationId);
  generationStreams.get(generationId)?.close();
  generationStreams.delete(generationId);
  generationOwners.delete(generationId);
  releaseInactiveMessages();
}

function findMessage(conversationId: string, messageId: string): MessageDto | undefined {
  return appStore.get().messages[conversationId]?.find((item) => item.id === messageId);
}

function applyGeneration(conversationId: string, messageId: string, generation: GenerationDto): void {
  if (conversationDeleted(conversationId)) return;
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
  const messages = appStore.get().messages[conversationId];
  if (messages) persistOfflineMessages(conversationId, messages, !isGenerationActive(generation.status));
}

let appEventsSubscription: Subscription | null = null;

export function stopAppEvents(): void {
  generationBlocks.clear();
  appEventsSubscription?.close(); appEventsSubscription = null;
  for (const stream of generationStreams.values()) stream.close();
  generationStreams.clear();
  generationOwners.clear();
  eventsSession++; eventRefreshes.clear();
  releaseInactiveMessages();
}

export function startAppEvents(): void {
  if (isOffline()) return;
  if (appEventsSubscription) return;
  startNotificationSession();
  let hasConnected = false;
  appEventsSubscription = subscribeAppEvents(
    (event) => {
      observeNotificationEvent(event);
      if (event.type === "generation-snapshot") {
        const ids = new Set(event.active.filter((state) => generating(state.status)).map((state) => state.generationId));
        const previous = new Map(generationOwners);
        // Going offline releases stream owners but keeps active message data.
        // Reconcile those messages too when a generation ended while disconnected.
        for (const [conversationId, messages] of Object.entries(appStore.get().messages)) {
          for (const message of messages) for (const generation of message.generations) {
            if (generating(generation.status)) previous.set(generation.id, { conversationId, messageId: message.id });
          }
        }
        for (const [id, owner] of previous) if (!ids.has(id)) {
          const session = eventsSession;
          eventRefreshes.schedule(`settled:${id}`, async () => {
            await messageReads.get(owner.conversationId)?.catch(() => {});
            if (session !== eventsSession) return;
            try { await loadMessages(owner.conversationId); } finally { closeGenerationStream(id); }
          });
        }
        for (const state of event.active) {
          if (generating(state.status)) { trackGeneration(state.conversationId, state.messageId, state.generationId); refreshMessages(state.conversationId); }
        }
      } else if (event.type === "generation-state") {
        const state = event.generation;
        if (generating(state.status)) { trackGeneration(state.conversationId, state.messageId, state.generationId); refreshMessages(state.conversationId); }
        else {
          const existing = findMessage(state.conversationId, state.messageId)?.generations.find((item) => item.id === state.generationId);
          if (existing) applyGeneration(state.conversationId, state.messageId, { ...withBlocks(existing, generationBlocks.take(state.generationId)), status: state.status, stopReason: state.stopReason });
          closeGenerationStream(state.generationId); refreshMessages(state.conversationId);
        }
      } else if (event.type === "resync") {
        eventRefreshes.schedule("conversations", refreshConversations);
        eventRefreshes.schedule("settings", refreshSettings);
        eventRefreshes.schedule("agents", refreshAgents);
        eventRefreshes.schedule("models", refreshConnectionsAndModels);
        eventRefreshes.schedule("tasks", refreshTaskCounts);
        const id = currentConversationId(); if (id) refreshMessages(id);
        window.dispatchEvent(new Event("llm-chat:queue-reconnect"));
        for (const resource of ["agents", "conversations", "settings", "connections", "models"]) {
          window.dispatchEvent(new CustomEvent("llm-chat:resource-changed", { detail: { resource } }));
        }
      } else if (event.type === "message-queue") {
        window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: event }));
        // Generation snapshots/state events determine which background chats need messages.
        refreshMessages(event.conversationId);
      } else if (event.type === "task") {
        eventRefreshes.schedule("tasks", refreshTaskCounts);
      } else if (event.type === "image-generation") {
        refreshMessages(event.conversationId);
      } else if (event.type === "resource-changed") {
        if (event.resource === "agents") eventRefreshes.schedule("agents", refreshAgents);
        if (event.resource === "conversations") eventRefreshes.schedule("conversations", refreshConversations);
        if (event.resource === "settings") eventRefreshes.schedule("settings", refreshSettings);
        if (event.resource === "connections" || event.resource === "models") eventRefreshes.schedule("models", refreshConnectionsAndModels);
        eventRefreshes.schedule(`resource:${event.resource}`, async () => {
          window.dispatchEvent(new CustomEvent("llm-chat:resource-changed", { detail: event }));
        });
      }
    },
    (connected) => {
      if (connected) eventRefreshes.schedule("conversations", refreshConversations);
      if (connected && hasConnected) eventRefreshes.schedule("settings", refreshSettings);
      if (connected) hasConnected = true;
      if (connected) window.dispatchEvent(new Event("llm-chat:queue-reconnect"));
      appStore.set({
        eventsConnectionState: connected ? "connected" : hasConnected ? "reconnecting" : "connecting"
      });
    }
  );
}

export async function refreshTaskCounts(): Promise<void> {
  const session = messageSession;
  try {
    const tasks = await api.get<Array<{ conversationId: string; status: string }>>("/api/background-tasks?scope=all");
    if (session !== messageSession) return;
    const runningTasksByConversation: Record<string, number> = {};
    for (const task of tasks) {
      if (conversationDeleted(task.conversationId) || !["queued", "starting", "running"].includes(task.status)) continue;
      runningTasksByConversation[task.conversationId] = (runningTasksByConversation[task.conversationId] ?? 0) + 1;
    }
    appStore.set({ runningTasksByConversation });
  } catch {
    /* ignore */
  }
}

export function initAuthGate(): () => void {
  const requireAuth = (event?: Event) => {
    messageSession++; messageReads.clear();
    stopNotificationSession();
    stopAppEvents();
    void clearOfflineHistory({ logout: true, broadcast: !(event instanceof CustomEvent && event.detail?.remote) }).catch(() => {});
    appStore.set({ auth: "required", messages: {}, conversations: [] });
  };
  const unsubscribeAuth = onAuthRequired(requireAuth);
  window.addEventListener("llm-chat:offline-auth-required", requireAuth);
  const unsubscribeOffline = offlineStore.subscribe(() => { if (isOffline()) stopAppEvents(); });
  return () => { unsubscribeAuth(); unsubscribeOffline(); window.removeEventListener("llm-chat:offline-auth-required", requireAuth); };
}

// All deletion signals converge here before routing or accepting another response.
window.addEventListener("llm-chat:conversations-deleted", (event) => {
  const { ids, local } = (event as CustomEvent<{ ids: string[]; local: boolean }>).detail;
  const removed = new Set(ids);
  const state = appStore.get();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.conversations) {
      if (item.forkedFrom && removed.has(item.forkedFrom.conversationId) && !removed.has(item.id)) {
        removed.add(item.id); changed = true;
      }
    }
  }
  const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
  if (currentId && removed.has(currentId)) {
    preserveDeletedDraft(currentId);
    replaceRoute("/");
    if (!local) toast("info", localized("WorkspaceSidebar.conversation_deleted"));
  }
  for (const id of removed) removeComposerDraft(id);
  for (const [id, owner] of generationOwners) {
    if (removed.has(owner.conversationId)) { closeGenerationStream(id); generationOwners.delete(id); }
  }
  appStore.set({
    conversations: state.conversations.filter((item) => !removed.has(item.id)),
    messages: Object.fromEntries(Object.entries(state.messages).filter(([id]) => !removed.has(id))),
    runningTasksByConversation: Object.fromEntries(Object.entries(state.runningTasksByConversation).filter(([id]) => !removed.has(id)))
  });
  markConversationsDeleted([...removed], local);
});
window.addEventListener("llm-chat:conversation-manifest", (event) => {
  const { conversations, knownIds, currentId } = (event as CustomEvent<{ conversations: ConversationDto[]; knownIds: string[]; currentId: string | null }>).detail;
  reconcileConversations(conversations, currentId, knownIds);
});
window.addEventListener("popstate", () => {
  releaseInactiveMessages();
  const id = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
  if (id && conversationDeleted(id)) replaceRoute("/");
});
