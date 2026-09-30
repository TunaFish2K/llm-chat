import { clearSubmissions, recordSubmissionAcceptance, saveSubmission, setSubmissionSource, submissionStore } from "./submission";
import { clearResources, invalidateResources } from "./resource";
import { uploadManager } from "./file-upload-manager";
import { errorDisplayMessage } from "./error-display";
import { t, type DisplayMessage, localized } from "./i18n";
import { RefreshScheduler } from "./refresh-scheduler";
import { GenerationBlockBuffer } from "./generation-block-buffer";
import { initializeDisplayPreferences } from "./local-display";
import { observeNotificationEvent, startNotificationSession, stopNotificationSession } from "./notifications";
import { conversationDeleted, deletionRevision, markConversationsDeleted, setConversationSource } from "./conversation-lifecycle";
import { preserveDeletedDraft, removeComposerDraft, resetComposerWrites } from "./composer-drafts";
import { replaceRoute } from "./router";
import { dequal } from "dequal";
import { clearMutationQueues, serializeMutation } from "./mutation-queue";
import { resolveConversationRoot } from "./conversation-tree";
import { clearOfflineHistory, isOffline, offlineStore, persistOfflineMessages, offlineRequest, markOffline } from "./offline-history";
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
import { api, endpoints, onAuthRequired, ApiRequestError } from "./api";
import { cancelGenerationHaptic, scheduleGenerationHaptic } from "./haptics";
import { createStore } from "./store";
import { resetRequestSession } from "./http-client";
import { clearStartupCache, readStartupCache, scheduleStartupCache, type StartupSnapshot } from "./startup-cache";
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
  bootRefreshing: boolean;
  sourceId: string | null;
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

const startup = readStartupCache();
export const appStore = createStore<AppState>({
  auth: "loading",
  bootError: null,
  bootRefreshing: false,
  sourceId: startup?.sourceId ?? null,
  settings: startup?.settings ?? null,
  agents: startup?.agents ?? [],
  connections: startup?.connections ?? [],
  models: startup?.models ?? [],
  conversations: startup?.conversations ?? [],
  messages: {},
  toasts: [],
  eventsConnectionState: "connecting",
  runningTasksByConversation: {}
});

if (startup) {
  setSubmissionSource(startup.sourceId);
  setConversationSource(startup.sourceId);
  uploadManager.setSource(startup.sourceId);
  initializeDisplayPreferences(startup.settings);
}
let lastSnapshot = appStore.get();
appStore.subscribe(() => {
  const state = appStore.get();
  const changed = state.sourceId !== lastSnapshot.sourceId || state.settings !== lastSnapshot.settings || state.agents !== lastSnapshot.agents
    || state.connections !== lastSnapshot.connections || state.models !== lastSnapshot.models || state.conversations !== lastSnapshot.conversations;
  lastSnapshot = state;
  if (!changed || state.auth !== "ready" || !state.sourceId || !state.settings) return;
  scheduleStartupCache(() => {
    const current = appStore.get();
    if (current.auth !== "ready" || !current.sourceId || !current.settings) return;
    const { sourceId, settings, agents, connections, models, conversations } = current;
    return { sourceId, settings, agents, connections, models, conversations } satisfies StartupSnapshot;
  });
});

function stableItems<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  const merged = next.map(item => { const old = byId.get(item.id); return old && dequal(old, item) ? old : item; });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}

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
  toast("error", errorDisplayMessage(error));
}

let bootSequence = 0;
let currentSource: string | undefined = startup?.sourceId;
export async function bootstrap(conversationId?: string, background = false): Promise<void> {
  const sequence = ++bootSequence;
  let session = messageSession;
  let networkFinished = false;
  const initialState = appStore.get();
  const knownIds = new Set(initialState.conversations.map(item => item.id));
  let cachedMessages: MessageDto[] | undefined;
  appStore.set({ bootError: null, bootRefreshing: true });
  const valid = () => sequence === bootSequence && session === messageSession;
  const accept = (data: import("./api").BootstrapDto, cached: boolean) => {
    if (!valid() || (cached && networkFinished)) return;
    if (data.sourceId) setSubmissionSource(data.sourceId);
    if (cached) {
      if (!currentSource) currentSource = data.sourceId;
      for (const item of data.conversations) knownIds.add(item.id);
    }
    if (!cached) {
      if (currentSource && data.sourceId && currentSource !== data.sourceId) {
        resetRequestSession();
        resetComposerWrites();
        clearStartupCache();
        clearResources(); clearSubmissions();
        if (data.sourceId) setSubmissionSource(data.sourceId);
        session = ++messageSession; messageReads.clear(); messageVisits.clear(); conversationWrites.clear(); unsavedConversations.clear(); branchSelections.clear(); generationSelections.clear(); settingsWrites = undefined; unsavedSettings = {}; clearMutationQueues(); stopAppEvents();
        appStore.set({ messages: {}, conversations: [] });
        knownIds.clear();
      }
      currentSource = data.sourceId;
      if (data.sourceId) setConversationSource(data.sourceId);
      offlineStore.set({ offline: false });
      const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
      reconcileConversations(data.conversations, currentId && knownIds.has(currentId) ? currentId : null, [...knownIds]);
      data.conversations = [...data.conversations, ...appStore.get().conversations.filter(item => !knownIds.has(item.id) && !data.conversations.some(next => next.id === item.id))];
      if (data.sourceId) uploadManager.setSource(data.sourceId);
    }
    data.conversations = data.conversations.filter(item => !conversationDeleted(item.id));
    // A background response for a previous route must not redirect the current page.
    const currentId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
    if (conversationId && conversationDeleted(conversationId)) {
      delete data.messages;
      if (currentId === conversationId) replaceRoute("/");
    }
    let messages = data.messages ? normalizeMessages(data.messages) : undefined;
    if (!cached && conversationId && appStore.get().messages[conversationId] !== initialState.messages[conversationId]
      && appStore.get().messages[conversationId] !== cachedMessages) messages = undefined;
    if (cached) cachedMessages = messages;
    appStore.set(state => ({ auth: "ready", sourceId: data.sourceId ?? null, agents: stableItems(state.agents, data.agents),
      connections: stableItems(state.connections, data.connections), models: stableItems(state.models, data.models),
      conversations: stableItems(state.conversations, data.conversations.map(item => overlayBranch(overlayConversation(item), data.conversations))),
      ...(conversationId && messages ? { messages: retainedMessages({ ...state.messages, [conversationId]: messages }) } : {}) }));
    acceptSettings(data.settings);
    if (!cached && conversationId && messages) for (const message of messages) {
      for (const generation of message.generations) if (generating(generation.status)) trackGeneration(conversationId, message.id, generation.id);
    }
  };
  const cached = !background && !initialState.sourceId ? offlineRequest("/api/bootstrap")
    .then(data => accept(data as import("./api").BootstrapDto, true)).catch(() => {}) : Promise.resolve();
  try {
    const data = await endpoints.bootstrap(conversationId, true);
    networkFinished = true;
    accept(data, false);
  } catch (error) {
    await cached;
    networkFinished = true;
    if (!valid()) return;
    if (error instanceof ApiRequestError && error.status === 401) {
      appStore.set({ auth: "required" });
    } else {
      markOffline();
      appStore.set({ bootError: error instanceof Error ? error.message : t("SettingsView.could_not_load") });
    }
  } finally {
    if (valid()) appStore.set({ bootRefreshing: false });
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
const branchSelections = new Map<string, { base: string; operations: Array<{ id: string }> }>();
function overlayBranch(item: ConversationDto, conversations: ConversationDto[]): ConversationDto {
  const write = branchSelections.get(resolveConversationRoot(item, conversations).id);
  return write ? { ...item, activeBranchId: write.operations.at(-1)?.id ?? write.base } : item;
}
export async function selectBranchImmediately(rootId: string, id: string): Promise<void> {
  const root = appStore.get().conversations.find(item => item.id === rootId);
  if (!root) return;
  let entry = branchSelections.get(rootId);
  if (!entry) { entry = { base: root.activeBranchId ?? rootId, operations: [] }; branchSelections.set(rootId, entry); }
  const operation = { id }; entry.operations.push(operation);
  browseOfflineBranch(id);
  const session = messageSession;
  const write = entry;
  conversationsReadSequence++;
  try {
    await serializeMutation(`branch:${rootId}`, () => endpoints.selectConversationBranch(rootId, id));
    if (session === messageSession) write.base = id;
  } finally {
    write.operations = write.operations.filter(item => item !== operation);
    if (session === messageSession && branchSelections.get(rootId) === write) {
      conversationsReadSequence++;
      browseOfflineBranch(write.operations.at(-1)?.id ?? write.base);
      if (!write.operations.length) branchSelections.delete(rootId);
    }
  }
}
type ConversationPatch = import("@llm-chat/contracts").PatchConversationInput;
interface ConversationWrite { patch: ConversationPatch }
const unsavedConversations = new Map<string, ConversationPatch>();
const conversationWrites = new Map<string, { base: ConversationDto; operations: ConversationWrite[]; tail: Promise<unknown> }>();
function applyConversationPatch(item: ConversationDto, patch: ConversationPatch): ConversationDto {
  const next = { ...item, ...patch } as ConversationDto;
  if (patch.agentId !== undefined && patch.agentId !== item.agentId) { next.executionOverrides = {}; next.modelId = null; }
  if (patch.modelId !== undefined) next.executionOverrides = { ...next.executionOverrides, modelId: patch.modelId };
  if (patch.executionOverrides || patch.agentId !== undefined) {
    const agent = appStore.get().agents.find(value => value.id === next.agentId);
    next.modelId = Object.hasOwn(next.executionOverrides, "modelId") ? next.executionOverrides.modelId ?? null : agent?.execution.modelId ?? null;
  }
  return next;
}
function overlayConversation(item: ConversationDto): ConversationDto {
  const unsaved = unsavedConversations.get(item.id);
  if (unsaved) item = applyConversationPatch(item, unsaved);
  const write = conversationWrites.get(item.id);
  return write ? write.operations.reduce((value, operation) => applyConversationPatch(value, operation.patch), unsaved ? applyConversationPatch(write.base, unsaved) : write.base) : item;
}
export function updateConversationImmediately(id: string, patch: ConversationPatch): Promise<ConversationDto> {
  const current = appStore.get().conversations.find(item => item.id === id);
  if (!current || conversationDeleted(id)) return Promise.reject(new Error("Conversation not found"));
  let write = conversationWrites.get(id);
  if (!write) { write = { base: current, operations: [], tail: Promise.resolve() }; conversationWrites.set(id, write); }
  const operation = { patch };
  conversationsReadSequence++;
  write.operations.push(operation);
  appStore.set(state => ({ conversations: state.conversations.map(overlayConversation) }));
  const session = messageSession;
  const entry = write;
  const request = serializeMutation(`conversation:${id}`, async () => {
    if (session !== messageSession || conversationDeleted(id)) throw new Error("Conversation unavailable");
    try {
      const result = await endpoints.updateConversation(id, patch);
      if (session === messageSession && !conversationDeleted(id)) {
        entry.base = result;
        const failed = unsavedConversations.get(id);
        if (failed) {
          for (const key of Object.keys(patch)) delete failed[key as keyof ConversationPatch];
          if (!Object.keys(failed).length) unsavedConversations.delete(id);
        }
      }
      return result;
    } catch (error) {
      if (session === messageSession && !conversationDeleted(id)) unsavedConversations.set(id, { ...unsavedConversations.get(id), ...patch });
      throw error;
    }
  }).finally(() => {
    entry.operations = entry.operations.filter(item => item !== operation);
    if (session !== messageSession || conversationWrites.get(id) !== entry) return;
    conversationsReadSequence++;
    appStore.set(state => ({ conversations: state.conversations.map(item => item.id === id ? overlayConversation(entry.base) : item) }));
    if (!entry.operations.length) conversationWrites.delete(id);
  });
  entry.tail = request;
  return request;
}

export function submitConversation<T>(id: string, action: () => Promise<T>): Promise<T> {
  const session = messageSession;
  return serializeMutation(`conversation:${id}`, () => {
    if (session !== messageSession || conversationDeleted(id)) throw new Error("Conversation unavailable");
    if (unsavedConversations.has(id)) throw new Error(t("Composer.sync_failed_after_send"));
    return action();
  });
}
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
  if (!isOffline() && revision === deletionRevision()) reconcileConversations(conversations, currentId === currentConversationId() ? currentId : null, knownIds);
  appStore.set(state => ({ conversations: [
    ...conversations.map(item => overlayBranch(overlayConversation(item), conversations)),
    ...state.conversations.filter(item => !knownIds.includes(item.id) && !conversations.some(next => next.id === item.id))
  ].filter(item => !conversationDeleted(item.id)) }));
}

export async function refreshAgents(): Promise<void> {
  const session = messageSession;
  const agents = await endpoints.agents();
  if (session !== messageSession) return;
  appStore.set(state => ({ agents: stableItems(state.agents, agents) }));
}

export async function refreshConnectionsAndModels(): Promise<void> {
  const session = messageSession;
  const [connections, models] = await Promise.all([endpoints.connections(), endpoints.models()]);
  if (session !== messageSession) return;
  appStore.set(state => ({ connections: stableItems(state.connections, connections), models: stableItems(state.models, models) }));
}

let settingsReadSequence = 0;
type SettingsPatch = Parameters<typeof endpoints.updateSettings>[0];
let settingsWrites: { base: AppSettings; operations: SettingsPatch[]; tail: Promise<unknown> } | undefined;
let unsavedSettings: SettingsPatch = {};

export function acceptSettings(settings: AppSettings): void {
  const apply = (value: AppSettings, patch: SettingsPatch): AppSettings => ({ ...value, ...Object.fromEntries(Object.entries(patch).filter(([, field]) => field !== undefined)) });
  settings = apply(settings, unsavedSettings);
  if (settingsWrites) settings = settingsWrites.operations.reduce<AppSettings>(apply, apply(settingsWrites.base, unsavedSettings));
  initializeDisplayPreferences(settings);
  if (!dequal(appStore.get().settings, settings)) appStore.set({ settings });
}

export function updateSettingsImmediately(patch: SettingsPatch): Promise<AppSettings> {
  const current = appStore.get().settings;
  if (!current) return Promise.reject(new Error("Settings unavailable"));
  const entry = settingsWrites ??= { base: current, operations: [], tail: Promise.resolve() };
  entry.operations.push(patch); settingsReadSequence++;
  acceptSettings(current);
  const session = messageSession;
  const request = entry.tail.catch(() => {}).then(async () => {
    if (session !== messageSession) throw new Error("Session changed");
    try {
      const result = await endpoints.updateSettings(patch);
      if (session === messageSession) {
        entry.base = result;
        for (const key of Object.keys(patch)) delete unsavedSettings[key as keyof SettingsPatch];
      }
      return result;
    } catch (error) {
      if (session === messageSession) unsavedSettings = { ...unsavedSettings, ...patch };
      throw error;
    }
  }).finally(() => {
    entry.operations = entry.operations.filter(value => value !== patch);
    if (session !== messageSession || settingsWrites !== entry) return;
    settingsReadSequence++;
    if (!entry.operations.length) settingsWrites = undefined;
    acceptSettings(entry.base);
  });
  entry.tail = request;
  return request;
}

export async function refreshSettings(): Promise<void> {
  const session = messageSession;
  const sequence = ++settingsReadSequence;
  const settings = await endpoints.settings();
  if (session === messageSession && sequence === settingsReadSequence) acceptSettings(settings);
}

const messageReads = new Map<string, Promise<MessageDto[]>>();
const generationSelections = new Map<string, { base: string | null; operations: Array<{ id: string }> }>();
export async function selectGenerationImmediately(conversationId: string, messageId: string, id: string): Promise<void> {
  const message = appStore.get().messages[conversationId]?.find(item => item.id === messageId);
  if (!message) return;
  const key = `${conversationId}:${messageId}`;
  let entry = generationSelections.get(key);
  if (!entry) { entry = { base: message.activeGenerationId, operations: [] }; generationSelections.set(key, entry); }
  const operation = { id }; entry.operations.push(operation);
  const apply = () => appStore.set(state => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] ?? []).map(item => item.id === messageId ? { ...item, activeGenerationId: entry!.operations.at(-1)?.id ?? entry!.base, generatedModel: null } : item) } }));
  apply();
  const session = messageSession, write = entry;
  try {
    await serializeMutation(`message:${key}`, () => endpoints.selectGeneration(conversationId, messageId, id));
    if (session === messageSession) write.base = id;
  } finally {
    write.operations = write.operations.filter(item => item !== operation);
    if (session === messageSession && generationSelections.get(key) === write) {
      apply();
      if (!write.operations.length) { generationSelections.delete(key); refreshMessages(conversationId); }
    }
  }
}
let messageSession = 0;
let eventsSession = 0;
const eventRefreshes = new RefreshScheduler(() => {});
const currentConversationId = () => location.pathname.match(/^\/c\/([^/]+)/)?.[1] ?? null;
const generating = (status: string) => status === "queued" || status === "running";
const messageVisits = new Map<string, number>();

function retainedMessages(messages: AppState["messages"]): AppState["messages"] {
  const current = currentConversationId();
  const now = Date.now();
  if (current) { messageVisits.delete(current); messageVisits.set(current, now); }
  const active = new Set([...generationOwners.values()].map((owner) => owner.conversationId));
  const recent = new Set([...messageVisits].reverse().filter(([id, touched]) => id !== current && !active.has(id) && now - touched < 600_000)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id));
  for (const [id, touched] of messageVisits) if (conversationDeleted(id) || now - touched >= 600_000) messageVisits.delete(id);
  return Object.fromEntries(Object.entries(messages).filter(([id, list]) => !conversationDeleted(id)
    && (id === current || active.has(id) || recent.has(id) || list.some((message) => message.generations.some((generation) => isGenerationActive(generation.status))))));
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
  const initial = appStore.get().messages[conversationId];
  const read = (async () => {
    let networkDone = false;
    const cached = offlineRequest(`/api/conversations/${conversationId}/messages`).then(data => {
      if (!networkDone && session === messageSession && !conversationDeleted(conversationId) && !appStore.get().messages[conversationId]) {
        appStore.set(state => ({ messages: retainedMessages({ ...state.messages, [conversationId]: normalizeMessages(data as MessageDto[]) }) }));
      }
    }).catch(() => {});
    let raw: MessageDto[];
    try { raw = await endpoints.messages(conversationId); }
    catch (error) { await cached; throw error; }
    networkDone = true;
    if (initial && raw.length > 12 && currentConversationId() === conversationId && document.visibilityState === "visible") {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }
    if (session !== messageSession || conversationDeleted(conversationId)) return [];
    let messages = normalizeMessages(raw);
    const current = appStore.get().messages[conversationId];
    messages = messages.map(message => {
      const selection = generationSelections.get(`${conversationId}:${message.id}`);
      return selection ? { ...message, activeGenerationId: selection.operations.at(-1)?.id ?? selection.base, generatedModel: null } : message;
    });
    if (current) {
      const liveById = new Map(current.map(message => [message.id, message]));
      const beforeById = new Map(initial?.map(message => [message.id, message]));
      messages = messages.map(message => {
        const live = liveById.get(message.id), before = beforeById.get(message.id);
        if (!live) return message;
        if (live !== before) {
          const beforeGenerations = new Map(before?.generations.map(generation => [generation.id, generation]));
          const liveGenerations = new Map(live.generations.map(generation => [generation.id, generation]));
          message = { ...message,
            ...(before?.activeGenerationId !== live.activeGenerationId ? { activeGenerationId: live.activeGenerationId, generatedModel: live.generatedModel } : {}),
            generations: message.generations.map(generation => {
              const next = liveGenerations.get(generation.id);
              return next && next !== beforeGenerations.get(next.id) && (isGenerationActive(generation.status) || !isGenerationActive(next.status)) ? next : generation;
            }) };
          const fetchedIds = new Set(message.generations.map(generation => generation.id));
          for (const generation of live.generations) if (!fetchedIds.has(generation.id) && !beforeGenerations.has(generation.id)) message.generations.push(generation);
        }
        return dequal(live, message) ? live : message;
      });
      const ids = new Set(messages.map(message => message.id));
      for (const message of current) if (!ids.has(message.id) && !beforeById.has(message.id)) messages.push(message);
      messages.sort((a, b) => a.ordinal - b.ordinal);
      if (messages.length === current.length && messages.every((message, index) => message === current[index])) messages = current;
    }
    if (messages !== current) appStore.set((state) => ({ messages: retainedMessages({ ...state.messages, [conversationId]: messages }) }));
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

export function acceptSubmission(value: import("@llm-chat/contracts").SubmissionAcceptedDto): void {
  const state = appStore.get();
  if (state.auth === "required" || state.sourceId && state.sourceId !== value.sourceId || conversationDeleted(value.conversation.id) || submissionStore.get().accepted[value.clientSubmissionId]) return;
  // Retain a newly accepted conversation before the route has changed to it.
  if (value.kind !== "queue") {
    const generation = value.kind === "start" ? value.result.generation : value.result;
    const existing = findMessage(value.conversation.id, generation.assistantMessageId)?.generations.find(item => item.id === generation.generationId);
    if (!existing || isGenerationActive(existing.status)) trackGeneration(value.conversation.id, generation.assistantMessageId, generation.generationId);
  }
  appStore.set(state => ({ conversations: state.conversations.some(item => item.id === value.conversation.id) ? state.conversations : [value.conversation, ...state.conversations] }));
  for (const message of value.messages) {
    // Replay must not replace a generation that has already received deltas.
    if (!appStore.get().messages[value.conversation.id]?.some(item => item.id === message.id)) upsertMessage(value.conversation.id, message);
  }
  recordSubmissionAcceptance(value);
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
  if (appEventsSubscription) return;
  startNotificationSession();
  let hasConnected = false;
  appEventsSubscription = subscribeAppEvents(
    (event) => {
      observeNotificationEvent(event);
      if (event.type === "submission-accepted") {
        acceptSubmission(event.submission);
      } else if (event.type === "generation-snapshot") {
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
      } else if (event.type === "container-resource") {
        window.dispatchEvent(new CustomEvent("llm-chat:container-resource", { detail: event.job }));
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
    resetRequestSession();
    resetComposerWrites();
    clearStartupCache();
    clearResources(); clearSubmissions();
    currentSource = undefined;
    uploadManager.reset();
    messageSession++; messageReads.clear(); messageVisits.clear(); conversationWrites.clear(); unsavedConversations.clear(); branchSelections.clear(); generationSelections.clear(); settingsWrites = undefined; unsavedSettings = {}; clearMutationQueues();
    stopNotificationSession();
    stopAppEvents();
    void clearOfflineHistory({ logout: true, broadcast: !(event instanceof CustomEvent && event.detail?.remote) }).catch(() => {});
    appStore.set({ auth: "required", sourceId: null, messages: {}, conversations: [], settings: null, agents: [], connections: [], models: [] });
  };
  const unsubscribeAuth = onAuthRequired(requireAuth);
  window.addEventListener("llm-chat:offline-auth-required", requireAuth);
  return () => { unsubscribeAuth(); window.removeEventListener("llm-chat:offline-auth-required", requireAuth); };
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
  for (const id of removed) {
    removeComposerDraft(id); saveSubmission(id, null);
    invalidateResources(key => key === `tasks:${id}` || key === `context:${id}` || key.startsWith("task:"));
  }
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

window.addEventListener("llm-chat:conversations-deleted", (event) => {
  for (const id of (event as CustomEvent<{ ids: string[] }>).detail.ids) uploadManager.removeConversation(id);
});
