import { useMessageEntrance } from "../components/chat/useMessageEntrance";
import { VirtualMessageList } from "../components/chat/VirtualMessageList";
import { submissionStore, type SubmissionActions } from "../lib/submission";
import { Presence } from "../lib/motion";
import { useErrorState } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { browseOfflineBranch } from "../lib/app-state";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, Images } from "lucide-react";
import type { AgentDto, ConversationRoleplayState, ForkConversationInput, MessageDto } from "@llm-chat/contracts";
import { readComposerDraft } from "../lib/composer-drafts";
import { endpoints } from "../lib/api";
import {
  appStore,
  isGenerationActive,
  loadMessages,
  refreshConversations,
  selectBranchImmediately,
  toast,
  toastError,
  trackGeneration
} from "../lib/app-state";
import type { InspectionTarget } from "../lib/inspection";
import { captureNavigation, linkClick, navigate, navigateIfCurrent, routes } from "../lib/router";
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
import { assetUrl } from "../lib/server-channel";

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
  const conversation = useStore(
    appStore,
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null
  );
  const conversations = useStore(appStore, (state) => state.conversations);
  const messages = useStore(appStore, (state) => (conversationId ? state.messages[conversationId] ?? null : null));
  const pendingSubmission = useStore(submissionStore, state => state.pending[conversationId ?? "new"]);
  const submissionActions = useRef<SubmissionActions | null>(null);
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
  const actionsNode = useRef<HTMLDivElement>(null);
  const [newGreetingIndex, setNewGreetingIndex] = useState(() => readComposerDraft(conversationId ?? null)?.greetingIndex ?? 0);
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(() => readComposerDraft(conversationId ?? null)?.agentId ?? null);
  const [roleplayOpen, setRoleplayOpen] = useState(false);
  const [roleplaySession, setRoleplaySession] = useState<{ agent: AgentDto; state: ConversationRoleplayState } | null>(null);
  const scroller = useStickToBottom([messages], view === "chat");
  const enteringMessages = useMessageEntrance(conversationId, messages, !scroller.detached);

  const busy = Boolean(
    messages?.some((message) => message.generations.some((generation) => isGenerationActive(generation.status)))
  );
  const userMessageCount = messages?.filter((message) => message.role === "user").length ?? 0;
  const branchGroups = useMemo(
    () => conversation ? conversationBranchGroups(conversation, conversations) : [],
    [conversation, conversations]
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Attaching the header tools triggers another render; let the chat paint first.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { timer = setTimeout(() => setActionsHost(actionsNode.current), 0); });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);

  const retryAnswer = useCallback(async (assistantMessageId: string) => {
    if (!conversationId || busy || branching || retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    try {
      const result = await endpoints.retryGeneration(conversationId, assistantMessageId);
      trackGeneration(conversationId, result.assistantMessageId, result.generationId);
      void loadMessages(conversationId).catch(toastError);
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

  useEffect(() => { setRoleplayOpen(false); }, [conversation?.id, conversation?.agentId]);

  useEffect(() => {
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
    const owner = captureNavigation();
    setBranching(true);
    try {
      const result = await endpoints.forkConversation(source.id, input);
      appStore.set(state => ({ conversations: [result.conversation, ...state.conversations.filter(item => item.id !== result.conversation.id)] }));
      void Promise.all([refreshConversations(), loadMessages(result.conversation.id)]).catch(toastError);
      if (result.generation) {
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
      }
      navigateIfCurrent(routes.chat(result.conversation.id), owner);
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
    browseOfflineBranch(branchId); navigate(routes.chat(branchId));
    try {
      await selectBranchImmediately(resolveConversationRoot(conversation, appStore.get().conversations).id, branchId);
      void refreshConversations().catch(toastError);
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
    branching: branching || busy || retrying
  }), [onInspect, retryAnswer, continueFrom, switchGreeting, switchBranch, branching, busy, retrying]);
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
    <div className="chat-workspace" data-conversation-id={conversationId ?? "new"} data-roleplay-background={background ? true : undefined} style={roleplayStyle}>
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
        actionsRef={actionsNode}
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
                {!conversationId && !pendingSubmission ? (
                  <NewConversationWelcome
                    agentId={previewAgentId}
                    greetingIndex={newGreetingIndex}
                    onGreetingIndexChange={setNewGreetingIndex}
                  />
                ) : !conversationId ? null : loadError && messages === null ? (
                  <ErrorState message={loadError} onRetry={() => readMessages(conversationId)} />
                ) : messages === null ? (
                  <LoadingState label={t("ChatView.loading_messages")} />
                ) : messages.length === 0 ? (
                  <EmptyState title={t("ChatView.this_conversation_has_no_messages_yet")} hint={t("ChatView.send_your_first_message_below")} />
                ) : (
                  <VirtualMessageList messages={transcript.messages} scroller={scroller.ref} following={!scroller.detached} renderMessage={(message) => (
                    <MessageItem
                      key={message.id}
                      enter={enteringMessages.has(message.id)}
                      conversationId={conversationId}
                      message={message}
                      imageJobs={transcript.imageJobs}
                      retryTargetId={retryTargets.get(message.id)}
                      branchGroups={branchesByOrdinal.get(message.ordinal) ?? EMPTY_BRANCH_GROUPS}
                      callbacks={streamCallbacks}
                    />
                  )} />
                )}
                {pendingSubmission ? <MessageItem conversationId={conversationId ?? "new"} callbacks={streamCallbacks}
                  message={{ id: pendingSubmission.id, ordinal: (messages?.length ?? 0) + 1, role: "user", text: pendingSubmission.text,
                    attachments: pendingSubmission.attachments ?? [], generations: [], activeGenerationId: null, generatedModel: null,
                    greeting: null, createdAt: pendingSubmission.createdAt ?? 0 }}
                  submission={{ value: pendingSubmission, actions: {
                    retry: value => submissionActions.current?.retry(value), edit: value => submissionActions.current?.edit(value),
                    cancel: value => submissionActions.current?.cancel(value)
                  } }} /> : null}
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
        conversationId={conversationId}
        submissionActions={submissionActions}
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

      {expression ? <img className="roleplay-expression" src={assetUrl(expression.uri)} alt="" aria-hidden="true" /> : null}

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

      <Presence>{editingMessage ? (
        <EditForkDialog
          conversationId={conversation?.id}
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
      ) : null}</Presence>
      <Presence>{roleplayOpen && conversation && roleplaySession ? (
        <RoleplayConversationDialog
          conversationId={conversation.id}
          agent={roleplaySession.agent}
          initial={roleplaySession.state}
          onClose={() => setRoleplayOpen(false)}
          onSaved={(state) => setRoleplaySession((current) => current ? { ...current, state } : current)}
        />
      ) : null}</Presence>
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
      <><article className="msg greeting-preview" data-role="assistant">
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
      </article><ImageStudioEntry /></>
    );
  }
  return (
    <div className="welcome">
      <AgentAvatar agent={selected} size="large" label={selected?.name ?? t("WorkspaceSidebar.new_conversation")} />
      <h1>{selected?.name ?? t("WorkspaceSidebar.new_conversation")}</h1>
      <p>{selected?.description || t("ChatView.choose_an_agent_and_model_then_start_a_conversation")}</p>
      <ImageStudioEntry />
    </div>
  );
}

function ImageStudioEntry() {
  const path = routes.images();
  return <a className="welcome-image-studio" href={path} onClick={linkClick(path)}>
    <Images size={18} aria-hidden="true" />
    <span><strong>{t("ImageStudio.open")}</strong><small>{t("ImageStudio.open_description")}</small></span>
  </a>;
}
