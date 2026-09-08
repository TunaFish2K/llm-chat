import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowDown } from "lucide-react";
import type { AgentDto, ConversationRoleplayState, ForkConversationInput, MessageDto } from "@llm-chat/contracts";
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
import { BranchSwitchers, MessageItem, VersionSwitcher } from "../components/chat/MessageStream";
import { conversationBranchGroups, greetingBranchContext, resolveConversationRoot } from "../lib/conversation-tree";
import { greetingOptions } from "../components/chat/model";
import { EditForkDialog } from "../components/chat/dialogs";
import { RoleplayConversationDialog } from "../components/chat/RoleplayConversationDialog";
import { useStickToBottom } from "../components/chat/useStickToBottom";
import { Markdown } from "../lib/markdown";

const TrajectoryView = lazy(() => import("./TrajectoryView").then((module) => ({ default: module.TrajectoryView })));
const ConversationTasksView = lazy(() =>
  import("./TasksView").then((module) => ({ default: module.ConversationTasksView }))
);

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
  onToggleSidebar = () => undefined,
  onToggleInspector = () => undefined,
  onInspect = () => undefined,
  onViewChange = () => undefined
}: ChatViewProps) {
  const conversation = useStore(
    appStore,
    (state) => state.conversations.find((item) => item.id === conversationId) ?? null
  );
  const conversations = useStore(appStore, (state) => state.conversations);
  const messages = useStore(appStore, (state) => (conversationId ? state.messages[conversationId] ?? null : null));
  const runningTasks = useStore(appStore, (state) =>
    conversationId ? state.runningTasksByConversation[conversationId] ?? 0 : 0
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDto | null>(null);
  const [branching, setBranching] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [newGreetingIndex, setNewGreetingIndex] = useState(0);
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(null);
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

  const readMessages = (id: string) => {
    setLoadError(null);
    void loadMessages(id).catch((error) => setLoadError(error instanceof Error ? error.message : "消息加载失败"));
  };

  useEffect(() => {
    setLoadError(null);
    setNewGreetingIndex(0);
    setPreviewAgentId(null);
    scroller.reset();
    if (!conversationId) return;
    let active = true;
    void loadMessages(conversationId).catch((error) => {
      if (active) setLoadError(error instanceof Error ? error.message : "消息加载失败");
    });
    return () => {
      active = false;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversation || !conversationId || !conversation.activeBranchId) return;
    const root = resolveConversationRoot(conversation, conversations);
    if (root.id === conversation.id && conversation.activeBranchId !== conversationId) {
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
  const forkConversationFrom = async (sourceConversationId: string, input: ForkConversationInput): Promise<boolean> => {
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
      toast("success", input.mode === "edit" ? "已从修改后的消息创建分支" : "已从检查点创建分支");
      return true;
    } catch (error) {
      toastError(error);
      return false;
    } finally {
      setBranching(false);
    }
  };

  const forkConversation = (input: ForkConversationInput): Promise<boolean> =>
    conversation ? forkConversationFrom(conversation.id, input) : Promise.resolve(false);

  const switchBranch = async (branchId: string) => {
    if (!conversation) return;
    try {
      await endpoints.selectConversationBranch(conversation.id, branchId);
      await refreshConversations();
      navigate(routes.chat(branchId));
    } catch (error) {
      toastError(error);
    }
  };

  const switchGreeting = (message: MessageDto, greetingIndex: number) => {
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
  };

  const compactContext = async () => {
    if (!conversation || compacting || busy) return;
    setCompacting(true);
    try {
      const summary = await endpoints.compactContext(conversation.id);
      toast("success", `已压缩到消息 #${summary.throughOrdinal}`);
      window.dispatchEvent(new Event("llm-chat:context-summary"));
    } catch (error) {
      toastError(error);
    } finally {
      setCompacting(false);
    }
  };

  const continueFrom = (messageId: string) => void forkConversation({ mode: "continue", throughMessageId: messageId });

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
      />

      <div className="chat-scroll-shell">
            <div
              className="chat-scroll"
              ref={scroller.ref}
              onScroll={scroller.onScroll}
              aria-live="polite"
              aria-label="消息列表"
            >
              <div className="chat-thread">
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
                  <LoadingState label="正在加载消息…" />
                ) : messages.length === 0 ? (
                  <EmptyState title="这个会话还没有消息" hint="从下方发送第一条消息。" />
                ) : (
                  messages.map((message) => (
                    <MessageItem
                      key={message.id}
                      conversationId={conversationId}
                      message={message}
                      branchGroups={branchGroups.filter((group) => group.messageOrdinal === message.ordinal)}
                      callbacks={{
                        onInspect,
                        onEdit: setEditingMessage,
                        onContinue: continueFrom,
                        onGreetingFork: switchGreeting,
                        onBranchChange: (id) => void switchBranch(id),
                        branching: branching || busy
                      }}
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
                aria-label="回到最新消息"
                title="回到最新消息"
              >
                <ArrowDown size={17} />
              </button>
            ) : null}
      </div>
      <Composer
        conversation={conversation}
        onInspect={onInspect}
        onBeforeSend={() => scroller.toBottom()}
        greetingIndex={newGreetingIndex}
        onGreetingIndexChange={setNewGreetingIndex}
        onPreviewAgentChange={setPreviewAgentId}
        compacting={compacting}
        canCompact={
          userMessageCount >= 3 &&
          (conversation?.contextPolicy === "auto" || conversation?.contextPolicy === "summarize")
        }
        onCompact={() => void compactContext()}
        roleplayAvailable={Boolean(conversation && roleplaySession)}
        roleplayAgent={roleplaySession?.agent ?? null}
        roleplayState={roleplaySession?.state ?? null}
        onRoleplayStateChange={(state) => setRoleplaySession((current) => current ? { ...current, state } : current)}
        onOpenRoleplay={() => setRoleplayOpen(true)}
      />

      {expression ? <img className="roleplay-expression" src={expression.uri} alt="" aria-hidden="true" /> : null}

      {view !== "chat" && conversation ? (
        <section className="conversation-overlay" aria-label={view === "tasks" ? "后台任务" : "运行轨迹"}>
          <h2 className="sr-only">{view === "tasks" ? "后台任务" : "运行轨迹"}</h2>
          {view === "tasks" ? (
            <Suspense fallback={<LoadingState label="正在加载后台任务…" />}>
              <ConversationTasksView conversationId={conversation.id} taskId={taskId} />
            </Suspense>
          ) : (
            <Suspense fallback={<LoadingState label="正在生成轨迹…" />}>
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
            <span>开场白</span>
          </div>
        </div>
        <Markdown text={greeting.text} />
        {greetings.length > 1 ? (
          <footer className="stream-footer greeting-footer">
            <VersionSwitcher
              label="开场白切换"
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
      <AgentAvatar agent={selected} size="large" label={selected?.name ?? "新会话"} />
      <h1>{selected?.name ?? "新会话"}</h1>
      <p>{selected?.description || "选择 Agent 和模型，然后开始对话。"}</p>
    </div>
  );
}
