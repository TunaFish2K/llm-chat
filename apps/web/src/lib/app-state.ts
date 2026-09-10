import { overlayResource, optimisticWrite } from "./optimistic-resource";
import { saveTypography } from "./local-typography";
import { conversationDeleted, deletionRevision, markConversationsDeleted, setConversationSource } from "./conversation-lifecycle";
import { preserveDeletedDraft, removeComposerDraft } from "./composer-drafts";
import { replaceRoute, navigate } from "./router";
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
import { api, apiRevision, endpoints, onAuthRequired } from "./api";
import { cancelGenerationHaptic, scheduleGenerationHaptic, setGenerationHapticsEnabled } from "./haptics";
import { createStore } from "./store";
import { subscribeAppEvents, subscribeGeneration, type Subscription } from "./sse";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
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

export function toast(kind: Toast["kind"], text: string): void {
  const id = ++toastSeq;
  appStore.set((state) => ({ toasts: [...state.toasts.slice(-4), { id, kind, text }] }));
  setTimeout(() => {
    appStore.set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  }, 5_000);
}

export function toastError(error: unknown): void {
  if (error instanceof Error && "code" in error && ["conversation_not_found", "conversation_deleted_local", "request_invalidated"].includes(String(error.code))) return;
  if (isOffline() && error instanceof Error && /网络|联网|fetch|同步/.test(error.message)) return;
  toast("error", error instanceof Error ? error.message : String(error));
}

export async function bootstrap(conversationId?: string, background = false): Promise<void> {
  if (!background) appStore.set({ auth: "loading", bootError: null });
  try {
    const knownIds = appStore.get().conversations.map((item) => item.id);
    const data = await endpoints.bootstrap(conversationId);
    if (data.sourceId) setConversationSource(data.sourceId);
    if (!isOffline()) reconcileConversations(data.conversations, conversationId ?? null, knownIds);
    data.conversations = data.conversations.filter((item) => !conversationDeleted(item.id));
    if (conversationId && conversationDeleted(conversationId)) { delete data.messages; replaceRoute("/"); }
    setGenerationHapticsEnabled(data.settings.uiPreferences.generationHaptics);
    const normalizedMessages = data.messages ? normalizeMessages(data.messages) : undefined;
    const bootMessages = conversationId && normalizedMessages ? { [conversationId]: normalizedMessages } : {};
    appStore.set({
      auth: "ready",
      settings: data.settings,
      agents: data.agents,
      connections: data.connections,
      models: data.models,
      conversations: data.conversations,
      ...(conversationId && normalizedMessages ? { messages: background ? { ...appStore.get().messages, ...bootMessages } : bootMessages } : {})
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
    if (!background) appStore.set({ auth: "loading", bootError: error instanceof Error ? error.message : "加载失败" });
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
  const sequence = ++conversationsReadSequence;
  const revision = deletionRevision();
  const knownIds = appStore.get().conversations.map((item) => item.id);
  const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
  const requestVersion = apiRevision();
  const conversations = await endpoints.conversations();
  if (sequence !== conversationsReadSequence || requestVersion !== apiRevision()) return;
  if (!isOffline() && revision === deletionRevision()) reconcileConversations(conversations, currentId, knownIds);
  const next = conversations.filter((item) => !conversationDeleted(item.id)).map((item) => overlayResource(`conversation:${item.id}`, item));
  const roots = new Set(next.map((item) => resolveConversationRoot(item, next).id));
  for (const root of roots) {
    const family = next.filter((item) => resolveConversationRoot(item, next).id === root);
    const projected = overlayResource(`branch:${root}`, family);
    for (const value of projected) { const index = next.findIndex((item) => item.id === value.id); if (index >= 0) next[index] = value; }
  }
  appStore.set({ conversations: next });
}

export async function refreshAgents(): Promise<void> {
  const agents = await endpoints.agents();
  appStore.set({ agents });
}

let connectionsReadSequence = 0;
export async function refreshConnectionsAndModels(): Promise<void> {
  const sequence = ++connectionsReadSequence, revision = apiRevision();
  const [connections, models] = await Promise.all([endpoints.connections(), endpoints.models()]);
  if (sequence !== connectionsReadSequence || revision !== apiRevision()) return;
  appStore.set({ connections, models: models.map((model) => overlayResource(`model:${model.id}`, model)) });
}

type UiPreferences = AppSettings["uiPreferences"];
export const preferenceSaveStore = createStore<{ status: "saved" | "saving" | "error" }>({ status: "saved" });
let pendingPreferences: Partial<UiPreferences> = {};
let preferenceRevision = 0;
const preferenceVersions = new Map<keyof UiPreferences, number>();
let preferenceTimer: ReturnType<typeof setTimeout> | undefined;
let preferenceWrite: Promise<void> | null = null;
let settingsReadSequence = 0;

export function acceptSettings(settings: AppSettings): void {
  settings = overlayResource("settings", settings);
  const merged = { ...settings, uiPreferences: { ...settings.uiPreferences, ...pendingPreferences } };
  setGenerationHapticsEnabled(merged.uiPreferences.generationHaptics);
  appStore.set({ settings: merged });
}

export function updateUiPreferences(patch: Partial<UiPreferences>): void {
  const { chatFontSize, chatLetterSpacing, chatLineHeight, ...shared } = patch;
  const typography = Object.fromEntries(Object.entries({ chatFontSize, chatLetterSpacing, chatLineHeight }).filter(([, value]) => value !== undefined));
  if (Object.keys(typography).length) saveTypography(typography);
  patch = shared;
  if (!Object.keys(patch).length) return;
  const settings = appStore.get().settings;
  if (!settings) return;
  const revision = ++preferenceRevision;
  for (const key of Object.keys(patch) as (keyof UiPreferences)[]) preferenceVersions.set(key, revision);
  pendingPreferences = { ...pendingPreferences, ...patch };
  acceptSettings(settings);
  preferenceSaveStore.set({ status: "saving" });
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(() => void flushUiPreferences(), 300);
}

export function flushUiPreferences(): Promise<void> {
  clearTimeout(preferenceTimer);
  if (preferenceWrite) return preferenceWrite;
  if (!Object.keys(pendingPreferences).length) return Promise.resolve();
  const patch = { ...pendingPreferences };
  const versions = new Map(preferenceVersions);
  preferenceSaveStore.set({ status: "saving" });
  preferenceWrite = (async () => {
    try {
      const saved = await endpoints.updateSettings({ uiPreferences: patch });
      ++settingsReadSequence;
      for (const key of Object.keys(patch) as (keyof UiPreferences)[]) {
        if (versions.get(key) === preferenceVersions.get(key)) {
          delete pendingPreferences[key];
          preferenceVersions.delete(key);
        }
      }
      acceptSettings(saved);
      preferenceSaveStore.set({ status: Object.keys(pendingPreferences).length ? "saving" : "saved" });
    } catch {
      preferenceSaveStore.set({ status: "error" });
    } finally {
      preferenceWrite = null;
    }
    if (preferenceSaveStore.get().status === "saving") await flushUiPreferences();
  })();
  return preferenceWrite;
}

export async function refreshSettings(): Promise<void> {
  const sequence = ++settingsReadSequence;
  const settings = await endpoints.settings();
  if (sequence === settingsReadSequence) acceptSettings(settings);
}

const messageReads = new Map<string, number>();
const messageChanges = new Map<string, number>();
export async function loadMessages(conversationId: string): Promise<MessageDto[]> {
  if (conversationDeleted(conversationId)) return [];
  const read = (messageReads.get(conversationId) ?? 0) + 1;
  messageReads.set(conversationId, read);
  const change = messageChanges.get(conversationId) ?? 0;
  const messages = normalizeMessages(await endpoints.messages(conversationId));
  if (conversationDeleted(conversationId)) return [];
  if (messageReads.get(conversationId) !== read) return appStore.get().messages[conversationId] ?? [];
  const existing = appStore.get().messages[conversationId] ?? [];
  const next = messages.map((message) => {
    const current = existing.find((item) => item.id === message.id);
    const merged = current && change !== (messageChanges.get(conversationId) ?? 0)
      ? { ...message, generations: [...message.generations.map((generation) => {
          const live = current.generations.find((item) => item.id === generation.id);
          return live && (isGenerationActive(generation.status) || !isGenerationActive(live.status)) ? live : generation;
        }), ...current.generations.filter((generation) => !message.generations.some((item) => item.id === generation.id))] }
      : message;
    return overlayResource(`message:${message.id}`, merged);
  });
  appStore.set((state) => ({ messages: { ...state.messages, [conversationId]: next } }));
  persistOfflineMessages(conversationId, next, true);
  for (const message of next) for (const generation of message.generations) {
    if (isGenerationActive(generation.status)) trackGeneration(conversationId, message.id, generation.id);
  }
  return next;
}

export function acceptConversation(value: ConversationDto): void {
  if (conversationDeleted(value.id)) return;
  appStore.set((state) => ({ conversations: [...state.conversations.filter((item) => item.id !== value.id), overlayResource(`conversation:${value.id}`, value)] }));
}
export function saveConversation(id: string, patch: Partial<ConversationDto>, optimistic = patch): Promise<ConversationDto> {
  const current = appStore.get().conversations.find((item) => item.id === id);
  if (!current) return Promise.reject(new Error("会话不存在"));
  return optimisticWrite(`conversation:${id}`, current, (value) => ({ ...value, ...optimistic }),
    (value) => { if (!conversationDeleted(id)) appStore.set((state) => ({ conversations: state.conversations.map((item) => item.id === id ? value : item) })); },
    () => endpoints.updateConversation(id, patch));
}
export function selectMessageVersion(conversationId: string, messageId: string, generationId: string): Promise<MessageDto> {
  const current = appStore.get().messages[conversationId]?.find((item) => item.id === messageId);
  if (!current) return Promise.reject(new Error("消息不存在"));
  const apply = (value: MessageDto): MessageDto => ({ ...value, activeGenerationId: generationId, generatedModel: null });
  return optimisticWrite(`message:${messageId}`, current, apply, (value) => upsertMessage(conversationId, value), async () => {
    await endpoints.selectGeneration(conversationId, messageId, generationId);
    return apply(appStore.get().messages[conversationId]?.find((item) => item.id === messageId) ?? current);
  });
}

const branchVersions = new Map<string, number>();
export async function selectBranch(conversationId: string, branchId: string): Promise<void> {
  if (conversationDeleted(branchId)) return;
  const known = appStore.get().conversations;
  if (!known.some((item) => item.id === conversationId)) return;
  const before = location.pathname;
  const family = appStore.get().conversations.filter((item) => resolveConversationRoot(item, appStore.get().conversations).id === resolveConversationRoot(appStore.get().conversations.find((item) => item.id === conversationId)!, appStore.get().conversations).id);
  const root = resolveConversationRoot(family[0]!, appStore.get().conversations);
  const version = (branchVersions.get(root.id) ?? 0) + 1;
  branchVersions.set(root.id, version);
  const promise = optimisticWrite(`branch:${root.id}`, family, (items) => items.map((item) => ({ ...item, activeBranchId: branchId })),
    (items) => appStore.set((state) => ({ conversations: state.conversations.map((item) => items.find((entry) => entry.id === item.id) ?? item) })),
    async () => { await endpoints.selectConversationBranch(root.id, branchId); return family.map((item) => ({ ...item, activeBranchId: branchId })); });
  const target = `/c/${branchId}`;
  navigate(target);
  try { await promise; } catch (error) { if (branchVersions.get(root.id) === version && location.pathname === target) replaceRoute(before); throw error; }
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
    return { messages: { ...state.messages, [conversationId]: next } };
  });
}

export function isGenerationActive(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting-approval";
}

const generationStreams = new Map<string, Subscription>();
const generationOwners = new Map<string, { conversationId: string; messageId: string }>();

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
  if (!owner) {
    if (event.type === "snapshot") {
      generationOwners.set(generationId, { conversationId: "", messageId: "" });
    }
    return;
  }
  if (event.type === "snapshot") {
    applyGeneration(owner.conversationId, owner.messageId, event.generation);
    if (generationStreamEnded(event.generation.status)) closeGenerationStream(generationId);
    return;
  }
  const message = findMessage(owner.conversationId, owner.messageId);
  const generation = message?.generations.find((item) => item.id === generationId);
  if (!message || !generation) return;
  const next: GenerationDto = { ...generation };
  if (event.type === "block-delta") {
    const blocks = [...next.blocks];
    // Stream IDs are synthetic; persisted snapshots use database IDs.
    const index = blocks.findIndex((block) => block.index === event.block.index && block.stepIndex === event.block.stepIndex);
    const contentChanged = index < 0 ? Boolean(event.block.content) : blocks[index]!.content !== event.block.content;
    if (index >= 0) blocks[index] = event.block;
    else blocks.push(event.block);
    blocks.sort((a, b) => a.index - b.index);
    next.blocks = blocks;
    if (contentChanged && isGenerationActive(generation.status)) scheduleGenerationHaptic();
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
  if (event.type === "status" && generationStreamEnded(event.status)) {
    closeGenerationStream(generationId);
    if (!isGenerationActive(event.status)) {
      // Final status may update message-level fields; re-sync from the server.
      try {
        await loadMessages(owner.conversationId);
      } catch {
        /* ignore */
      }
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
  generationStreams.get(generationId)?.close();
  generationStreams.delete(generationId);
}

function findMessage(conversationId: string, messageId: string): MessageDto | undefined {
  return appStore.get().messages[conversationId]?.find((item) => item.id === messageId);
}

function applyGeneration(conversationId: string, messageId: string, generation: GenerationDto): void {
  messageChanges.set(conversationId, (messageChanges.get(conversationId) ?? 0) + 1);
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
  appEventsSubscription?.close(); appEventsSubscription = null;
  for (const stream of generationStreams.values()) stream.close();
  generationStreams.clear();
}

export function startAppEvents(): void {
  if (isOffline()) return;
  if (appEventsSubscription) return;
  let hasConnected = false;
  appEventsSubscription = subscribeAppEvents(
    (event) => {
      if (event.type === "message-queue") {
        window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: event }));
        void loadMessages(event.conversationId).then(() => {
          if (event.generation) trackGeneration(event.conversationId, event.generation.assistantMessageId, event.generation.generationId);
        }).catch(toastError);
      } else if (event.type === "task") {
        void refreshTaskCounts();
      } else if (event.type === "image-generation") {
        void loadMessages(event.conversationId).catch(toastError);
      } else if (event.type === "resource-changed") {
        if (event.resource === "agents") void refreshAgents();
        if (event.resource === "conversations") void refreshConversations().catch(toastError);
        if (event.resource === "settings") void refreshSettings();
        if (event.resource === "connections" || event.resource === "models") void refreshConnectionsAndModels();
        window.dispatchEvent(new CustomEvent("llm-chat:resource-changed", { detail: event }));
      }
    },
    (connected) => {
      if (connected) void refreshConversations().catch(toastError);
      if (connected && hasConnected) void refreshSettings().catch(toastError);
      if (connected) hasConnected = true;
      if (connected) window.dispatchEvent(new Event("llm-chat:queue-reconnect"));
      appStore.set({
        eventsConnectionState: connected ? "connected" : hasConnected ? "reconnecting" : "connecting"
      });
    }
  );
}

export async function refreshTaskCounts(): Promise<void> {
  try {
    const tasks = await api.get<Array<{ conversationId: string; status: string }>>("/api/background-tasks?scope=all");
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

export function initAuthGate(): void {
  const requireAuth = (event?: Event) => {
    window.dispatchEvent(new Event("llm-chat:submissions-clear"));
    stopAppEvents();
    void clearOfflineHistory({ logout: true, broadcast: !(event instanceof CustomEvent && event.detail?.remote) }).catch(() => {});
    appStore.set({ auth: "required", messages: {}, conversations: [] });
  };
  onAuthRequired(requireAuth);
  window.addEventListener("llm-chat:offline-auth-required", requireAuth);
  offlineStore.subscribe(() => { if (isOffline()) stopAppEvents(); });
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
    if (!local) toast("info", "会话已删除");
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
  const id = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
  if (id && conversationDeleted(id)) replaceRoute("/");
});

window.addEventListener("llm-chat:action-error", (event) => toastError((event as CustomEvent).detail));

export function saveSettings(patch: import("@llm-chat/contracts").AppSettingsUpdate): Promise<AppSettings> {
  const current = appStore.get().settings!;
  return optimisticWrite("settings", current, (value) => ({ ...value, ...patch,
    uiPreferences: { ...value.uiPreferences, ...patch.uiPreferences } } as AppSettings),
    acceptSettings, () => endpoints.updateSettings(patch));
}

export function saveModelEnabled(model: ModelDto, enabled: boolean): Promise<ModelDto> {
  return optimisticWrite(`model:${model.id}`, model, (value) => ({ ...value, enabled }),
    (value) => appStore.set((state) => ({ models: state.models.map((item) => item.id === model.id ? value : item) })),
    () => endpoints.updateModel(model.id, { enabled }));
}
