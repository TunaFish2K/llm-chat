import { useErrorState } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { isOffline, offlineStore } from "../lib/offline-history";
import { browseOfflineBranch } from "../lib/app-state";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import type { AgentDto, ConversationRoleplayState, ForkConversationInput, MessageDto } from "@llm-chat/contracts";
import { readComposerDraft } from "../lib/composer-drafts";
import { endpoints } from "../lib/api";
import {
  appStore,
  isGenerationActive,
  loadMessages,
  refreshConversations,
  toast,
  toastError,
  trackGeneration
} from "../lib/app-state";
import type { InspectionTarget } from "../lib/inspection";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { EmptyState, ErrorState, LoadingState } from "../components/ui";
import { AgentAvatar } from "../components/chat/atoms";
import { Composer } from "../components/chat/Composer";
import { ConversationHeader, type ConversationView } from "../components/chat/ConversationHeader";
import { BranchSwitchers, MessageItem, VersionSwitcher, type StreamCallbacks } from "../components/chat/MessageStream";
import { conversationBranchGroups, greetingBranchContext, resolveConversationRoot } from "../lib/conversation-tree";
import { greetingOptions, createTranscriptProjection, EMPTY_MESSAGES, userReplyTargets } from "../components/chat/model";
import { EditForkDialog } from "../components/chat/dialogs";
import { RoleplayConversationDialog } from "../components/chat/RoleplayConversationDialog";
import { useStickToBottom } from "../components/chat/useStickToBottom";
import { Markdown } from "../lib/markdown";

const TrajectoryView = lazy(() => import("./TrajectoryView").then((module) => ({ default: module.TrajectoryView })));
const ConversationTasksView = lazy(() =>
  import("./TasksView").then((module) => ({ default: module.ConversationTasksView }))
);

const noop = () => undefined;
const EMPTY_BRANCH_GROUPS: ReturnType<typeof conversationBranchGroups> = [];

interface ChatViewProps {
  conversationId: string | null;
  view?: ConversationView;
  taskId?: string | null;
  mobile?: boolean;
  sidebarCollapsed?: boolean;
  inspectorOpen?: boolean;
  onToggleSidebar?: () => void;
  onToggleInspector?: () => void;
  onInspect?: (target: InspectionTarget) => void;
  onViewChange?: (view: ConversationView) => void;
}

/**
 * Composition root for a conversation. It owns only what spans the header, the
 * transcript and the composer: which messages are loaded, whether a branch is
 * being created, and where the scroller is parked. Everything else lives in
 * `components/chat`.
 */
export function ChatView({
  conversationId,
  view = "chat",
  taskId = null,
  mobile = false,
  sidebarCollapsed = false,
  inspectorOpen = false,
  onToggleSidebar = noop,
  onToggleInspector = noop,
  onInspect = noop,
  onViewChange = noop
}: ChatViewProps) {
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const conversation = useStore(
    appStore,
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null
  );
  const conversations = useStore(appStore, (state) => state.conversations);
  const messages = useStore(appStore, (state) => (conversationId ? state.messages[conversationId] ?? null : null));
  const runningTasks = useStore(appStore, (state) =>
    conversationId ? state.runningTasksByConversation[conversationId] ?? 0 : 0
  );
  const [loadError, setLoadError] = useErrorState(null);
  const [editingMessage, setEditingMessage] = useState<MessageDto | null>(null);
  const [branching, setBranching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryPending = useRef(false);
  const retryTargets = useMemo(() => userReplyTargets(messages ?? []), [messages]);
  const projectTranscript = useMemo(createTranscriptProjection, []);
  const transcript = useMemo(() => projectTranscript(messages ?? EMPTY_MESSAGES), [messages, projectTranscript]);
  const [compacting, setCompacting] = useState(false);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [newGreetingIndex, setNewGreetingIndex] = useState(() => readComposerDraft(conversationId ?? null)?.greetingIndex ?? 0);
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(() => readComposerDraft(conversationId ?? null)?.agentId ?? null);
  const [roleplayOpen, setRoleplayOpen] = useState(false);
  const [roleplaySession, setRoleplaySession] = useState<{ agent: AgentDto; state: ConversationRoleplayState } | null>(null);
  const scroller = useStickToBottom([messages], view === "chat");

  const busy = Boolean(
    messages?.some((message) => message.generations.some((generation) => isGenerationActive(generation.status)))
  );
  const userMessageCount = messages?.filter((message) => message.role === "user").length ?? 0;
  const branchGroups = useMemo(
    () => conversation ? conversationBranchGroups(conversation, conversations) : [],
    [conversation, conversations]
  );

  const retryAnswer = useCallback(async (assistantMessageId: string) => {
    if (!conversationId || busy || branching || retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    try {
      const result = await endpoints.retryGeneration(conversationId, assistantMessageId);
      trackGeneration(conversationId, result.assistantMessageId, result.generationId);
      await loadMessages(conversationId);
    } catch (error) {
      toastError(error);
    } finally {
      retryPending.current = false;
      setRetrying(false);
    }
  }, [conversationId, busy, branching]);

  const readMessages = (id: string) => {
    setLoadError(null);
    void loadMessages(id).catch((error) => setLoadError(error instanceof Error ? error : t("ChatView.could_not_load_messages")));
  };

  useEffect(() => {
    setLoadError(null);
    const draft = readComposerDraft(conversationId ?? null);
    setNewGreetingIndex(draft?.greetingIndex ?? 0);
    setPreviewAgentId(draft?.agentId ?? null);
    scroller.reset();
    if (!conversationId) return;
    let active = true;
    void loadMessages(conversationId).catch((error) => {
      if (active) setLoadError(error instanceof Error ? error : t("ChatView.could_not_load_messages"));
    });
    return () => {
      active = false;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversation || !conversationId || !conversation.activeBranchId) return;
    const root = resolveConversationRoot(conversation, conversations);
    if (!offline && root.id === conversation.id && conversation.activeBranchId !== conversationId) {
      navigate(routes.chat(conversation.activeBranchId));
    }
  }, [conversation, conversationId, conversations]);

  useEffect(() => {
    setRoleplayOpen(false);
    const summary = conversations.length && conversation?.agentId
      ? appStore.get().agents.find((agent) => agent.id === conversation.agentId)
      : undefined;
    if (!conversation || !summary?.roleplayEnabled) {
      setRoleplaySession(null);
      return;
    }
    let active = true;
    void Promise.all([endpoints.agent(summary.id), endpoints.conversationRoleplayState(conversation.id)])
      .then(([agent, state]) => { if (active) setRoleplaySession({ agent, state }); })
      .catch(() => { if (active) setRoleplaySession(null); });
    return () => { active = false; };
  }, [conversation?.id, conversation?.agentId, conversations]);

  /** Forking always lands the reader on the new branch; the source is untouched. */
  const forkConversationFrom = useCallback(async (sourceConversationId: string, input: ForkConversationInput): Promise<boolean> => {
    const source = conversations.find((item) => item.id === sourceConversationId);
    if (!source || branching || busy) return false;
    setBranching(true);
    try {
      const result = await endpoints.forkConversation(source.id, input);
      await refreshConversations();
      await loadMessages(result.conversation.id);
      if (result.generation) {
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
      }
      navigate(routes.chat(result.conversation.id));
      toast("success", input.mode === "edit" ? t("ChatView.created_a_branch_from_the_edited_message") : t("ChatView.created_a_branch_from_the_checkpoint"));
      return true;
    } catch (error) {
      toastError(error);
      return false;
    } finally {
      setBranching(false);
    }
  }, [conversations, branching, busy]);

  const forkConversation = useCallback((input: ForkConversationInput): Promise<boolean> =>
    conversation ? forkConversationFrom(conversation.id, input) : Promise.resolve(false), [conversation, forkConversationFrom]);

  const switchBranch = useCallback(async (branchId: string) => {
    if (!conversation) return;
    if (isOffline()) { browseOfflineBranch(branchId); navigate(routes.chat(branchId)); return; }
    try {
      await endpoints.selectConversationBranch(conversation.id, branchId);
      await refreshConversations();
      navigate(routes.chat(branchId));
    } catch (error) {
      toastError(error);
    }
  }, [conversation]);

  const switchGreeting = useCallback((message: MessageDto, greetingIndex: number) => {
    if (!conversation) return;
    const context = greetingBranchContext(conversation, message, conversations);
    const existing = context?.routesByGreetingIndex.get(greetingIndex);
    if (existing) {
      void switchBranch(existing);
      return;
    }
    void forkConversationFrom(context?.sourceConversationId ?? conversation.id, {
      mode: "greeting",
      messageId: context?.sourceMessageId ?? message.id,
      greetingIndex
    });
  }, [conversation, conversations, switchBranch, forkConversationFrom]);

  const compactContext = useCallback(async () => {
    if (!conversation || compacting || busy) return;
    setCompacting(true);
    try {
      const summary = await endpoints.compactContext(conversation.id);
      toast("success", localized("ChatView.compacted_through_message", { value1: (summary.throughOrdinal) }));
      window.dispatchEvent(new Event("llm-chat:context-summary"));
    } catch (error) {
      toastError(error);
    } finally {
      setCompacting(false);
    }
  }, [conversation, compacting, busy]);

  const continueFrom = useCallback((messageId: string) => void forkConversation({ mode: "continue", throughMessageId: messageId }), [forkConversation]);
  const streamCallbacks = useMemo<StreamCallbacks>(() => ({
    onInspect, onEdit: setEditingMessage, onRetry: (id) => void retryAnswer(id),
    onContinue: continueFrom, onGreetingFork: switchGreeting, onBranchChange: (id) => void switchBranch(id),
    branching: offline || branching || busy || retrying
  }), [onInspect, retryAnswer, continueFrom, switchGreeting, switchBranch, offline, branching, busy, retrying]);
  const branchesByOrdinal = useMemo(() => {
    const result = new Map<number | null, typeof branchGroups>();
    for (const group of branchGroups) {
      const groups = result.get(group.messageOrdinal) ?? [];
      groups.push(group); result.set(group.messageOrdinal, groups);
    }
    return result;
  }, [branchGroups]);
  const beforeSend = useCallback(() => { scroller.toBottom("auto"); scroller.scheduleFollow(); }, [scroller.toBottom, scroller.scheduleFollow]);
  const updateRoleplayState = useCallback((state: ConversationRoleplayState) => setRoleplaySession((current) => current ? { ...current, state } : current), []);
  const openRoleplay = useCallback(() => setRoleplayOpen(true), []);

  const background = roleplaySession?.agent.roleplay.assets.find((asset) =>
    asset.id === roleplaySession.state.backgroundAssetId && asset.mimeType?.startsWith("image/")
  );
  const expression = roleplaySession?.agent.roleplay.assets.find((asset) =>
    asset.id === roleplaySession.state.expressionAssetId && asset.mimeType?.startsWith("image/")
  );
  const roleplayStyle = background
    ? ({ "--roleplay-background": `url(${JSON.stringify(background.uri)})` } as CSSProperties)
    : undefined;

  return (
    <div className="chat-workspace" data-roleplay-background={background ? true : undefined} style={roleplayStyle}>
      <ConversationHeader
        conversation={conversation}
        view={view}
        mobile={mobile}
        sidebarCollapsed={sidebarCollapsed}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={onToggleSidebar}
        onToggleInspector={onToggleInspector}
        onViewChange={onViewChange}
        runningTasks={runningTasks}
        actionsRef={setActionsHost}
      />

      <div className="chat-scroll-shell">
            <div
              className="chat-scroll"
              ref={scroller.ref}
              onScroll={scroller.onScroll}
              data-following-bottom={!scroller.detached || undefined}
              aria-live="polite"
              aria-label={t("ChatView.message_list")}
            >
              <div className="chat-thread" ref={scroller.contentRef}>
                <div className="root-branch-controls">
                  <BranchSwitchers
                    groups={branchGroups.filter((group) => group.messageOrdinal === null)}
                    onChange={(id) => void switchBranch(id)}
                  />
                </div>
                {!conversationId ? (
                  <NewConversationWelcome
                    agentId={previewAgentId}
                    greetingIndex={newGreetingIndex}
                    onGreetingIndexChange={setNewGreetingIndex}
                  />
                ) : loadError ? (
                  <ErrorState message={loadError} onRetry={() => readMessages(conversationId)} />
                ) : messages === null ? (
                  <LoadingState label={t("ChatView.loading_messages")} />
                ) : messages.length === 0 ? (
                  <EmptyState title={t("ChatView.this_conversation_has_no_messages_yet")} hint={t("ChatView.send_your_first_message_below")} />
                ) : (
                  transcript.messages.map((message) => (
                    <MessageItem
                      key={message.id}
                      conversationId={conversationId}
                      message={message}
                      imageJobs={transcript.imageJobs}
                      retryTargetId={retryTargets.get(message.id)}
                      branchGroups={branchesByOrdinal.get(message.ordinal) ?? EMPTY_BRANCH_GROUPS}
                      callbacks={streamCallbacks}
                    />
                  ))
                )}
              </div>
            </div>
            {scroller.detached ? (
              <button
                type="button"
                className="icon-button jump-to-latest"
                onClick={() => scroller.toBottom("smooth")}
                aria-label={t("ChatView.go_to_latest_message")}
                title={t("ChatView.go_to_latest_message")}
              >
                <ArrowDown size={17} />
              </button>
            ) : null}
      </div>
      <Composer
        key={conversationId ?? "new"}
        actionsHost={actionsHost}
        mobile={mobile}
        conversation={conversation}
        onInspect={onInspect}
        onBeforeSend={beforeSend}
        greetingIndex={newGreetingIndex}
        onGreetingIndexChange={setNewGreetingIndex}
        onPreviewAgentChange={setPreviewAgentId}
        compacting={compacting}
        canCompact={
          userMessageCount >= 3 &&
          (conversation?.contextPolicy === "auto" || conversation?.contextPolicy === "summarize")
        }
        onCompact={compactContext}
        roleplayAvailable={Boolean(conversation && roleplaySession)}
        roleplayAgent={roleplaySession?.agent ?? null}
        roleplayState={roleplaySession?.state ?? null}
        onRoleplayStateChange={updateRoleplayState}
        onOpenRoleplay={openRoleplay}
      />

      {expression ? <img className="roleplay-expression" src={expression.uri} alt="" aria-hidden="true" /> : null}

      {view !== "chat" && conversation ? (
        <section className="conversation-overlay" aria-label={view === "tasks" ? t("TrajectoryView.background_tasks") : t("ChatView.activity")}>
          <h2 className="sr-only">{view === "tasks" ? t("TrajectoryView.background_tasks") : t("ChatView.activity")}</h2>
          {view === "tasks" ? (
            <Suspense fallback={<LoadingState label={t("ChatView.loading_background_tasks")} />}>
              <ConversationTasksView conversationId={conversation.id} taskId={taskId} />
            </Suspense>
          ) : (
            <Suspense fallback={<LoadingState label={t("ChatView.building_activity_view")} />}>
              <TrajectoryView
                conversation={conversation}
                onInspect={onInspect}
                onContinue={continueFrom}
                branching={branching || busy}
              />
            </Suspense>
          )}
        </section>
      ) : null}

      {editingMessage ? (
        <EditForkDialog
          message={editingMessage}
          busy={branching}
          onClose={() => setEditingMessage(null)}
          onSubmit={(text, assetIds) => {
            void (async () => {
              if (
                await forkConversation({
                  mode: "edit",
                  messageId: editingMessage.id,
                  text,
                  assetIds
                })
              ) {
                setEditingMessage(null);
              }
            })();
          }}
        />
      ) : null}
      {roleplayOpen && conversation && roleplaySession ? (
        <RoleplayConversationDialog
          conversationId={conversation.id}
          agent={roleplaySession.agent}
          initial={roleplaySession.state}
          onClose={() => setRoleplayOpen(false)}
          onSaved={(state) => setRoleplaySession((current) => current ? { ...current, state } : current)}
        />
      ) : null}
    </div>
  );
}

/** The pre-send state doubles as the Agent's own introduction. */
function NewConversationWelcome({
  agentId,
  greetingIndex,
  onGreetingIndexChange
}: {
  agentId: string | null;
  greetingIndex: number;
  onGreetingIndexChange: (index: number) => void;
}) {
  useLocale();
  const settings = useStore(appStore, (state) => state.settings);
  const agents = useStore(appStore, (state) => state.agents);
  const selected =
    agents.find((agent) => agent.id === agentId) ??
    agents.find((agent) => agent.id === settings?.lastAgentId) ??
    agents.find((agent) => agent.id === settings?.defaultAgentId) ??
    agents[0];
  const greetings = selected && settings ? greetingOptions(selected, settings) : [];
  const activeIndex = Math.max(0, greetings.findIndex((item) => item.sourceIndex === greetingIndex));
  const greeting = greetings[activeIndex];
  if (selected && greeting) {
    return (
      <article className="msg greeting-preview" data-role="assistant">
        <div className="msg-head">
          <AgentAvatar agent={selected} label={selected.name} />
          <div className="msg-identity">
            <strong>{selected.name}</strong>
            <span>{t("ChatView.greeting")}</span>
          </div>
        </div>
        <Markdown text={greeting.text} />
        {greetings.length > 1 ? (
          <footer className="stream-footer greeting-footer">
            <VersionSwitcher
              label={t("ChatView.greeting_selector")}
              index={activeIndex}
              total={greetings.length}
              onChange={(index) => {
                const option = greetings[index];
                if (option) onGreetingIndexChange(option.sourceIndex);
              }}
            />
          </footer>
        ) : null}
      </article>
    );
  }
  return (
    <div className="welcome">
      <AgentAvatar agent={selected} size="large" label={selected?.name ?? t("WorkspaceSidebar.new_conversation")} />
      <h1>{selected?.name ?? t("WorkspaceSidebar.new_conversation")}</h1>
      <p>{selected?.description || t("ChatView.choose_an_agent_and_model_then_start_a_conversation")}</p>
    </div>
  );
}
