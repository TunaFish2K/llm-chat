import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { Popover } from "radix-ui";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  FolderOpen,
  Gauge,
  GitFork,
  ImagePlus,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Square,
  Undo2,
  Wrench,
  X
} from "lucide-react";
import type {
  AgentSummaryDto,
  ConnectionBalanceDto,
  ConnectionDto,
  ContextPolicy,
  ConversationDto,
  ConversationExecutionOverrides,
  ForkConversationInput,
  GenerationDto,
  ImageAssetDto,
  MessageDto,
  ModelDto,
  ReasoningEffort,
  ToolCallDto,
  ToolCatalogItemDto
} from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { Markdown } from "../lib/markdown";
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
import { useStore } from "../lib/store";
import { navigate, routes } from "../lib/router";
import { fileToBase64, formatBytes, formatTime, formatTokens } from "../lib/format";
import { EmptyState, ErrorState, LoadingState, Modal, StatusTag } from "../lib/ui";
import { DirectoryPicker } from "../components/DirectoryPicker";

const TrajectoryView = lazy(() => import("./TrajectoryView").then((module) => ({ default: module.TrajectoryView })));
const REASONING_LEVELS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const CONTEXT_POLICIES: ContextPolicy[] = ["auto", "trim", "summarize", "full"];
const EMPTY_MESSAGES: MessageDto[] = [];
const INHERIT = "__inherit__";
const NO_MODEL = "__none__";

interface ChatViewProps {
  conversationId: string | null;
  view?: "chat" | "trajectory";
  sidebarCollapsed?: boolean;
  inspectorOpen?: boolean;
  onToggleSidebar?: () => void;
  onToggleInspector?: () => void;
  onInspect?: (target: InspectionTarget) => void;
  onViewChange?: (view: "chat" | "trajectory") => void;
}

export function ChatView({
  conversationId,
  view = "chat",
  sidebarCollapsed = false,
  inspectorOpen = false,
  onToggleSidebar = () => undefined,
  onToggleInspector = () => undefined,
  onInspect = () => undefined,
  onViewChange = () => undefined
}: ChatViewProps) {
  const conversation = useStore(appStore, (state) =>
    state.conversations.find((item) => item.id === conversationId) ?? null
  );
  const messages = useStore(appStore, (state) => conversationId ? state.messages[conversationId] ?? null : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDto | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [branching, setBranching] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const busy = Boolean(messages?.some((message) => message.generations.some((generation) => isGenerationActive(generation.status))));
  const userMessageCount = messages?.filter((message) => message.role === "user").length ?? 0;

  const forkConversation = async (input: ForkConversationInput): Promise<boolean> => {
    if (!conversation || branching || busy) return false;
    setBranching(true);
    try {
      const result = await endpoints.forkConversation(conversation.id, input);
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

  const undoLastTurn = async () => {
    if (!messages?.length) return;
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
    if (lastUserIndex < 0) return;
    const priorAssistant = messages.slice(0, lastUserIndex).findLast((message) => message.role === "assistant");
    if (await forkConversation({ mode: "continue", throughMessageId: priorAssistant?.id ?? null })) setUndoOpen(false);
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

  useEffect(() => {
    setLoadError(null);
    if (!conversationId) return;
    let active = true;
    void loadMessages(conversationId).catch((error) => {
      if (active) setLoadError(error instanceof Error ? error.message : "消息加载失败");
    });
    return () => { active = false; };
  }, [conversationId]);

  useEffect(() => {
    if (view !== "chat") return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, view]);

  return (
    <div className="chat-workspace">
      <ConversationHeader
        conversation={conversation}
        view={view}
        sidebarCollapsed={sidebarCollapsed}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={onToggleSidebar}
        onToggleInspector={onToggleInspector}
        onViewChange={onViewChange}
        busy={busy || branching}
        compacting={compacting}
        canUndo={userMessageCount > 0}
        canCompact={userMessageCount >= 3 && (conversation?.contextPolicy === "auto" || conversation?.contextPolicy === "summarize")}
        onUndo={() => setUndoOpen(true)}
        onCompact={() => void compactContext()}
      />
      {view === "trajectory" && conversation ? (
        <Suspense fallback={<LoadingState label="正在生成轨迹…" />}>
          <TrajectoryView
            conversation={conversation}
            onInspect={onInspect}
            onContinue={(messageId) => void forkConversation({ mode: "continue", throughMessageId: messageId })}
            branching={branching || busy}
          />
        </Suspense>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollRef} aria-live="polite" aria-label="消息列表">
            <div className="chat-message-rail">
              {!conversationId ? (
                <NewConversationWelcome />
              ) : loadError ? (
                <ErrorState message={loadError} onRetry={() => {
                  setLoadError(null);
                  void loadMessages(conversationId).catch((error) => setLoadError(error instanceof Error ? error.message : "消息加载失败"));
                }} />
              ) : messages === null ? (
                <LoadingState label="正在加载消息…" />
              ) : messages.length === 0 ? (
                <EmptyState title="这个会话还没有消息" hint="从下方发送第一条消息。" />
              ) : messages.map((message) => (
                <MessageView
                  key={message.id}
                  conversationId={conversationId}
                  message={message}
                  onInspect={onInspect}
                  onEdit={setEditingMessage}
                  onContinue={(messageId) => void forkConversation({ mode: "continue", throughMessageId: messageId })}
                  branching={branching || busy}
                />
              ))}
            </div>
          </div>
          <Composer conversation={conversation} onInspect={onInspect} />
        </>
      )}
      {editingMessage ? (
        <EditForkModal
          message={editingMessage}
          busy={branching}
          onClose={() => setEditingMessage(null)}
          onSubmit={async (text) => {
            if (await forkConversation({
              mode: "edit",
              messageId: editingMessage.id,
              text,
              imageAssetIds: editingMessage.attachments.map((asset) => asset.id)
            })) setEditingMessage(null);
          }}
        />
      ) : null}
      {undoOpen ? (
        <Modal
          title="撤销上一轮"
          onClose={() => setUndoOpen(false)}
          footer={<><button className="button secondary" onClick={() => setUndoOpen(false)}>取消</button><button className="button primary" disabled={branching} onClick={() => void undoLastTurn()}>{branching ? "正在创建…" : "创建回退分支"}</button></>}
        >
          <p>将从上一轮之前创建新分支，原会话保持不变。</p>
          <p className="small muted">只回退会话上下文，不恢复 Agent 已修改的工作区文件。</p>
        </Modal>
      ) : null}
    </div>
  );
}

function ConversationHeader({
  conversation,
  view,
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onViewChange,
  busy,
  compacting,
  canUndo,
  canCompact,
  onUndo,
  onCompact
}: Required<Omit<ChatViewProps, "conversationId" | "onInspect">> & {
  conversation: ConversationDto | null;
  busy: boolean;
  compacting: boolean;
  canUndo: boolean;
  canCompact: boolean;
  onUndo: () => void;
  onCompact: () => void;
}) {
  const conversations = useStore(appStore, (state) => state.conversations);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation?.title ?? "");
  const parent = conversation?.forkedFrom
    ? conversations.find((item) => item.id === conversation.forkedFrom?.conversationId)
    : undefined;
  useEffect(() => { setTitle(conversation?.title ?? ""); setEditing(false); }, [conversation?.id, conversation?.title]);
  const saveTitle = async () => {
    if (!conversation || !title.trim()) return;
    try {
      await endpoints.updateConversation(conversation.id, { title: title.trim() });
      await refreshConversations();
      setEditing(false);
    } catch (error) { toastError(error); }
  };

  return (
    <header className="conversation-header">
      <button className="icon-button shell-control" onClick={onToggleSidebar} aria-label={sidebarCollapsed ? "展开会话栏" : "折叠会话栏"} title={sidebarCollapsed ? "展开会话栏" : "折叠会话栏"}>
        {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
      <div className="conversation-heading">
        {editing ? (
          <input
            className="title-input"
            aria-label="会话标题"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveTitle();
              if (event.key === "Escape") { setTitle(conversation?.title ?? ""); setEditing(false); }
            }}
          />
        ) : (
          <button className="conversation-title" onDoubleClick={() => conversation && setEditing(true)} title={conversation ? "双击重命名" : undefined}>
            <strong>{conversation?.title || "新会话"}</strong>
            <span>{conversation ? "后续生成使用会话当前配置" : "首次发送后创建会话"}</span>
          </button>
        )}
        {parent ? (
          <button className="fork-source" onClick={() => navigate(routes.chat(parent.id))} title="返回来源会话">
            <GitFork size={11} />分叉自 {parent.title}
          </button>
        ) : null}
      </div>
      {conversation ? (
        <div className="view-switch" role="tablist" aria-label="会话视图">
          <button role="tab" aria-selected={view === "chat"} onClick={() => onViewChange("chat")}><MessageSquare size={15} />对话</button>
          <button role="tab" aria-selected={view === "trajectory"} onClick={() => onViewChange("trajectory")}><ListTree size={15} />轨迹</button>
        </div>
      ) : null}
      {conversation ? (
        <div className="header-actions">
          <button className="icon-button" onClick={onUndo} disabled={busy || !canUndo} aria-label="撤销上一轮" title="撤销上一轮（只回退会话）"><Undo2 size={17} /></button>
          <button
            className="icon-button"
            onClick={onCompact}
            disabled={busy || !canCompact}
            aria-label="立即压缩上下文"
            title={canCompact ? "立即压缩上下文" : "智能或摘要策略下，至少三轮对话后可压缩"}
          >
            {compacting ? <LoaderCircle className="spin" size={17} /> : <Minimize2 size={17} />}
          </button>
        </div>
      ) : null}
      <button className="icon-button shell-control" onClick={onToggleInspector} disabled={!conversation} aria-label={inspectorOpen ? "关闭检查器" : "打开检查器"} title={inspectorOpen ? "关闭检查器" : "打开检查器"}>
        {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
    </header>
  );
}

function NewConversationWelcome() {
  const settings = useStore(appStore, (state) => state.settings);
  const agents = useStore(appStore, (state) => state.agents);
  const selected = agents.find((agent) => agent.id === settings?.lastAgentId) ?? agents.find((agent) => agent.id === settings?.defaultAgentId);
  return (
    <div className="new-conversation-welcome">
      <AgentAvatar agent={selected} size="large" />
      <h1>{selected?.name ?? "新会话"}</h1>
      <p>{selected?.description || "选择 Agent 和模型，然后开始对话。"}</p>
    </div>
  );
}

function MessageView({
  conversationId,
  message,
  onInspect,
  onEdit,
  onContinue,
  branching
}: {
  conversationId: string;
  message: MessageDto;
  onInspect: (target: InspectionTarget) => void;
  onEdit: (message: MessageDto) => void;
  onContinue: (messageId: string) => void;
  branching: boolean;
}) {
  const agents = useStore(appStore, (state) => state.agents);
  const generation = message.role === "assistant" ? activeGeneration(message) : null;
  const agent = agents.find((item) => item.id === generation?.generatedAgent?.agentId);

  if (message.role === "user") {
    return (
      <article className="chat-message user-message" data-role="user">
        <div className="message-content">
          {message.attachments.length ? <ImageGallery assets={message.attachments} /> : null}
          {message.text ? <p>{message.text}</p> : null}
        </div>
        <footer className="message-footer">
          <time>{formatTime(message.createdAt)}</time>
          <IconAction label="复制消息" onClick={() => void copyText(message.text ?? "")}><Copy size={14} /></IconAction>
          <IconAction label="编辑并分叉" disabled={branching} onClick={() => onEdit(message)}><Pencil size={14} /></IconAction>
        </footer>
      </article>
    );
  }

  return (
    <article className="chat-message assistant-message" data-role="assistant">
      <header className="assistant-meta">
        <AgentAvatar agent={agent} label={generation?.generatedAgent?.name ?? "AI"} />
        <div><strong>{generation?.generatedAgent?.name ?? "助手"}</strong><span>{message.generatedModel ? `${message.generatedModel.connectionName} / ${message.generatedModel.displayName}` : "历史回复"}</span></div>
        <time>{formatTime(message.createdAt)}</time>
        {generation ? <StatusTag status={generation.status} /> : null}
      </header>
      {generation ? (
        <GenerationView conversationId={conversationId} message={message} generation={generation} onInspect={onInspect} onContinue={onContinue} branching={branching} />
      ) : message.text ? <Markdown text={message.text} /> : <p className="muted">（无生成内容）</p>}
    </article>
  );
}

function GenerationView({ conversationId, message, generation, onInspect, onContinue, branching }: {
  conversationId: string;
  message: MessageDto;
  generation: GenerationDto;
  onInspect: (target: InspectionTarget) => void;
  onContinue: (messageId: string) => void;
  branching: boolean;
}) {
  const settings = useStore(appStore, (state) => state.settings);
  const collapsePolicy = settings?.uiPreferences.reasoningCollapsePolicy ?? "collapse-on-answer";
  const hasAnswer = generation.blocks.some((block) => block.type === "text" && block.content.trim());
  const busy = isGenerationActive(generation.status);
  const versionIndex = message.generations.findIndex((item) => item.id === generation.id);
  const answer = generation.blocks.filter((block) => block.type === "text").map((block) => block.content).join("");
  const timeline = [
    ...generation.blocks.map((block) => ({ kind: "block" as const, stepIndex: block.stepIndex, index: block.index, block })),
    ...generation.toolCalls.map((call) => ({ kind: "tool" as const, stepIndex: call.stepIndex, index: call.index, call }))
  ].sort((left, right) => left.stepIndex - right.stepIndex || (left.kind === right.kind ? left.index - right.index : left.kind === "block" ? -1 : 1));

  const retry = async () => {
    try {
      const result = await endpoints.retryGeneration(message.id);
      await loadMessages(conversationId);
      trackGeneration(conversationId, result.assistantMessageId, result.generationId);
    } catch (error) { toastError(error); }
  };
  const selectVersion = async (id: string) => {
    try { await endpoints.selectGeneration(message.id, id); await loadMessages(conversationId); } catch (error) { toastError(error); }
  };

  return (
    <div className="generation-body">
      {timeline.map((item) => {
        if (item.kind === "tool") {
          return <ToolCallSummary key={item.call.id} call={item.call} onInspect={() => onInspect({ kind: "tool", messageId: message.id, generationId: generation.id, toolCallId: item.call.id })} />;
        }
        const { block } = item;
        if (block.type === "reasoning") {
          const open = collapsePolicy === "never-auto-collapse" || (collapsePolicy === "collapse-on-answer" && !hasAnswer && !generation.completedAt);
          return <details className="reasoning-block" key={block.id} open={open}><summary><Gauge size={14} />{block.complete ? "推理过程" : "正在推理"}<ChevronDown size={14} /></summary><div>{block.content}</div></details>;
        }
        if (block.type === "refusal") return <div className="refusal-block" role="alert" key={block.id}><strong>模型拒绝回答</strong><p>{block.content}</p></div>;
        if (block.type === "unsupported") return <div className="unsupported-block" key={block.id}>不支持的内容块：{block.content}</div>;
        return <Markdown key={block.id} text={block.content} streaming={!block.complete} />;
      })}
      {generation.error ? <div className="refusal-block" role="alert"><strong>生成失败（{generation.error.code}）</strong><p>{generation.error.message}</p></div> : null}
      {generation.stopReason && generation.status !== "completed" ? <p className="muted small">停止原因：{generation.stopReason}</p> : null}

      <footer className="generation-footer">
        <div className="generation-actions">
          {answer ? <IconAction label="复制回答" onClick={() => void copyText(answer)}><Clipboard size={14} /></IconAction> : null}
          {busy ? <IconAction label="停止生成" danger onClick={() => void endpoints.cancelGeneration(generation.id).catch(toastError)}><Square size={14} fill="currentColor" /></IconAction> : null}
          {!busy ? <IconAction label="重试" onClick={() => void retry()}><RotateCcw size={14} /></IconAction> : null}
          {!busy ? <IconAction label="从此处继续" disabled={branching} onClick={() => onContinue(message.id)}><GitFork size={14} /></IconAction> : null}
          <IconAction label="检查生成" onClick={() => onInspect({ kind: "generation", messageId: message.id, generationId: generation.id })}><Settings2 size={14} /></IconAction>
          {message.generations.length > 1 ? (
            <span className="generation-switcher" aria-label="生成版本切换">
              <button aria-label="上一版本" disabled={versionIndex <= 0} onClick={() => { const item = message.generations[versionIndex - 1]; if (item) void selectVersion(item.id); }}><ChevronLeft size={14} /></button>
              <span>{versionIndex + 1} / {message.generations.length}</span>
              <button aria-label="下一版本" disabled={versionIndex >= message.generations.length - 1} onClick={() => { const item = message.generations[versionIndex + 1]; if (item) void selectVersion(item.id); }}><ChevronRight size={14} /></button>
            </span>
          ) : null}
        </div>
        <button className="usage-summary" onClick={() => onInspect({ kind: "generation", messageId: message.id, generationId: generation.id })}>
          {generation.usage.inputTokens !== undefined ? <span>↑ {formatTokens(generation.usage.inputTokens)}</span> : null}
          {generation.usage.outputTokens !== undefined ? <span>↓ {formatTokens(generation.usage.outputTokens)}</span> : null}
          {generation.usage.totalTokens !== undefined ? <span>合计 {formatTokens(generation.usage.totalTokens)}</span> : null}
          {generation.usage.cachedInputTokens !== undefined ? <span>缓存 {formatTokens(generation.usage.cachedInputTokens)}</span> : null}
          {generation.completedAt ? <span>{Math.max(0, generation.completedAt - generation.createdAt)} ms</span> : null}
        </button>
      </footer>
    </div>
  );
}

function ToolCallSummary({ call, onInspect }: { call: ToolCallDto; onInspect: () => void }) {
  return (
    <details className="tool-call-summary" data-state={call.approvalState}>
      <summary>
        <Wrench size={15} /><code>{call.name}</code><span className="grow" />
        {call.approvalState === "pending" ? <span>等待审批</span> : null}
        <StatusTag status={call.approvalState} />
        <button className="message-action" onClick={(event) => { event.preventDefault(); onInspect(); }} aria-label="检查工具调用" title="检查工具调用"><Settings2 size={14} /></button>
        <ChevronDown size={14} />
      </summary>
      <div className="tool-call-details">
        <CodeField label="参数" value={prettyJson(call.arguments)} />
        {call.output ? <CodeField label="输出" value={prettyJson(call.output)} /> : null}
        {call.error ? <CodeField label="错误" value={call.error} danger /> : null}
        {call.artifacts.length ? <ImageGallery assets={call.artifacts} /> : null}
      </div>
    </details>
  );
}

function CodeField({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return <section className="tool-code-field"><strong>{label}</strong><pre data-danger={danger || undefined}>{value}</pre></section>;
}

function ImageGallery({ assets }: { assets: ImageAssetDto[] }) {
  return (
    <div className="message-images" data-count={Math.min(assets.length, 4)}>
      {assets.map((asset) => (
        <a key={asset.id} href={asset.url} target="_blank" rel="noopener noreferrer" title={`${asset.fileName} · ${formatBytes(asset.byteSize)}`}>
          <img src={asset.url} alt={asset.fileName} loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  );
}

function ComposerImages({ assets, onRemove }: { assets: ImageAssetDto[]; onRemove: (id: string) => void }) {
  return (
    <div className="composer-images" aria-label="待发送图片">
      {assets.map((asset) => (
        <div key={asset.id} className="composer-image">
          <img src={asset.url} alt={asset.fileName} />
          <span>{asset.fileName}</span>
          <button type="button" onClick={() => onRemove(asset.id)} aria-label={`移除 ${asset.fileName}`} title="移除图片"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

function Composer({ conversation, onInspect }: { conversation: ConversationDto | null; onInspect: (target: InspectionTarget) => void }) {
  const settings = useStore(appStore, (state) => state.settings);
  const agents = useStore(appStore, (state) => state.agents);
  const models = useStore(appStore, (state) => state.models);
  const connections = useStore(appStore, (state) => state.connections);
  const messages = useStore(appStore, (state) => conversation ? state.messages[conversation.id] ?? EMPTY_MESSAGES : EMPTY_MESSAGES);
  const [text, setText] = useState("");
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [newOverrides, setNewOverrides] = useState<ConversationExecutionOverrides>({});
  const [newWorkspace, setNewWorkspace] = useState<string | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [editingOverrides, setEditingOverrides] = useState(false);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ImageAssetDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedConversation = useRef<string | null>(null);
  const isNew = !conversation;

  useEffect(() => {
    if (conversation) {
      if (loadedConversation.current !== conversation.id) {
        loadedConversation.current = conversation.id;
        setText(conversation.draft);
        setAttachments([]);
      }
      return;
    }
    loadedConversation.current = null;
    setText("");
    setAttachments([]);
    setNewAgentId(null);
    setNewOverrides({});
    setNewWorkspace(settings?.lastWorkspacePath ?? null);
    setGreetingIndex(0);
  }, [conversation?.id]);

  const fallbackAgent = agents.find((agent) => agent.id === settings?.lastAgentId)
    ?? agents.find((agent) => agent.id === settings?.defaultAgentId)
    ?? agents[0];
  const effectiveAgentId = conversation?.agentId ?? newAgentId ?? fallbackAgent?.id ?? "";
  const effectiveAgent = agents.find((agent) => agent.id === effectiveAgentId);
  const overrides = conversation?.executionOverrides ?? newOverrides;
  const explicitModel = Object.hasOwn(overrides, "modelId") ? overrides.modelId : undefined;
  const effectiveModelId = conversation?.modelId ?? (explicitModel !== undefined ? explicitModel : effectiveAgent?.execution.modelId) ?? null;
  const effectiveModel = models.find((model) => model.id === effectiveModelId);
  const modelAvailable = Boolean(effectiveModel?.enabled && connections.some((connection) => connection.id === effectiveModel.connectionId));
  const visionModel = models.find((model) => model.id === effectiveAgent?.execution.visionModelId);
  const imageConfigured = Boolean(effectiveModel?.capabilities.imageInput || (visionModel?.enabled && visionModel.capabilities.imageInput));
  const reasoning = overrides.reasoningEffort ?? effectiveAgent?.execution.reasoningEffort ?? settings?.reasoningEffort ?? "none";
  const workspace = conversation?.workspacePath ?? newWorkspace;
  const greetings = effectiveAgent ? [effectiveAgent.firstMessage, ...effectiveAgent.alternateGreetings].filter(Boolean) : [];
  const active = messages.flatMap((message) => message.generations.map((generation) => ({ message, generation }))).find(({ generation }) => isGenerationActive(generation.status));
  const generating = Boolean(active && active.generation.status !== "waiting-approval");
  const pendingApprovals = messages.flatMap((message) => message.generations.flatMap((generation) => generation.toolCalls
    .filter((call) => call.approvalState === "pending")
    .map((call) => ({ message, generation, call })))).sort((left, right) => left.call.index - right.call.index);

  const persistDraft = (value: string) => {
    if (!conversation) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void endpoints.updateConversation(conversation.id, { draft: value }).catch(() => undefined); }, 500);
  };

  const saveOverrides = async (next: ConversationExecutionOverrides, message?: string) => {
    if (!conversation) {
      setNewOverrides(next);
      if (message) toast("success", message);
      return;
    }
    try {
      await endpoints.updateConversation(conversation.id, { executionOverrides: next });
      await refreshConversations();
      if (message) toast("success", message);
    } catch (error) { toastError(error); throw error; }
  };

  const chooseModel = (value: string) => {
    const next = { ...overrides };
    if (value === INHERIT) delete next.modelId;
    else next.modelId = value;
    void saveOverrides(next);
  };
  const chooseReasoning = (value: string) => {
    const next = { ...overrides };
    if (value === INHERIT) delete next.reasoningEffort;
    else next.reasoningEffort = value as ReasoningEffort;
    void saveOverrides(next);
  };

  const applyAgent = async (agentId: string) => {
    if (!conversation) {
      setNewAgentId(agentId);
      setNewOverrides({});
      setGreetingIndex(0);
      return;
    }
    try {
      await endpoints.updateConversation(conversation.id, { agentId });
      await refreshConversations();
      setPendingAgent(null);
    } catch (error) { toastError(error); }
  };
  const chooseAgent = (agentId: string) => {
    if (conversation && messages.length) setPendingAgent(agentId);
    else void applyAgent(agentId);
  };

  const chooseWorkspace = async (path: string | null) => {
    setPickingWorkspace(false);
    if (!conversation) { setNewWorkspace(path); return; }
    try {
      await endpoints.updateConversation(conversation.id, { workspacePath: path });
      await refreshConversations();
      toast("success", path ? "工作目录已更新" : "工作目录已清除");
    } catch (error) { toastError(error); }
  };

  const uploadImages = async (files: File[]) => {
    if (!files.length || uploading) return;
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
    const slots = Math.max(0, 4 - attachments.length);
    if (!slots) { toast("error", "每条消息最多附加 4 张图片"); return; }
    const selected = files.slice(0, slots);
    if (files.length > slots) toast("info", `只会添加前 ${slots} 张图片`);
    let totalBytes = attachments.reduce((sum, asset) => sum + asset.byteSize, 0);
    const accepted: File[] = [];
    for (const file of selected) {
      if (!allowed.has(file.type)) { toast("error", `${file.name || "图片"} 不是支持的图片格式`); continue; }
      if (file.size > 5 * 1024 * 1024) { toast("error", `${file.name || "图片"} 超过 5 MiB`); continue; }
      if (totalBytes + file.size > 15 * 1024 * 1024) { toast("error", "图片总大小不能超过 15 MiB"); break; }
      totalBytes += file.size;
      accepted.push(file);
    }
    if (!accepted.length) return;
    setUploading(true);
    try {
      const uploaded: ImageAssetDto[] = [];
      for (const [index, file] of accepted.entries()) {
        const fileName = file.name || `pasted-image-${Date.now()}-${index + 1}.png`;
        uploaded.push(await endpoints.uploadImage(fileName, await fileToBase64(file)));
      }
      setAttachments((current) => {
        const next = [...current];
        for (const asset of uploaded) if (!next.some((item) => item.id === asset.id)) next.push(asset);
        return next.slice(0, 4);
      });
    } catch (error) { toastError(error); } finally { setUploading(false); }
  };

  const sendMessage = async () => {
    const content = text.trim();
    if ((!content && !attachments.length) || sending || uploading || generating || pendingApprovals.length) return;
    if (!effectiveAgent) { toast("error", "请先选择一个 Agent"); return; }
    if (!modelAvailable) { toast("error", "请先选择一个可用模型"); return; }
    if (attachments.length && !imageConfigured) { toast("error", "当前模型不支持图片，请先为 Agent 配置备用识图模型"); return; }
    setSending(true);
    try {
      if (!conversation) {
        const result = await endpoints.startConversation({
          text: content,
          ...(attachments.length ? { imageAssetIds: attachments.map((asset) => asset.id) } : {}),
          agentId: effectiveAgent.id,
          greetingIndex,
          executionOverrides: newOverrides,
          workspacePath: newWorkspace
        });
        setText("");
        setAttachments([]);
        await refreshConversations();
        await loadMessages(result.conversation.id);
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
        navigate(routes.chat(result.conversation.id));
      } else {
        const result = await endpoints.sendMessage(conversation.id, content, attachments.map((asset) => asset.id));
        setText("");
        setAttachments([]);
        persistDraft("");
        await loadMessages(conversation.id);
        trackGeneration(conversation.id, result.assistantMessageId, result.generationId);
        await refreshConversations();
      }
    } catch (error) { toastError(error); } finally { setSending(false); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); }
  };

  return (
    <div className="composer-rail">
      <div
        className="composer-surface"
        onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault(); }}
        onDrop={(event) => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); void uploadImages(files); } }}
      >
        {isNew && greetings.length > 1 ? (
          <div className="greeting-switcher"><button disabled={greetingIndex === 0} onClick={() => setGreetingIndex((value) => value - 1)} aria-label="上一条开场白"><ChevronLeft size={14} /></button><span>开场白 {greetingIndex + 1} / {greetings.length}</span><button disabled={greetingIndex >= greetings.length - 1} onClick={() => setGreetingIndex((value) => value + 1)} aria-label="下一条开场白"><ChevronRight size={14} /></button></div>
        ) : null}
        {pendingApprovals.length && conversation ? (
          <ApprovalQueue
            conversation={conversation}
            item={pendingApprovals[0]!}
            count={pendingApprovals.length}
            onInspect={onInspect}
          />
        ) : (
          <>
            <textarea
              className="composer-input"
              aria-label="输入消息"
              placeholder={!effectiveAgent ? "请先选择 Agent" : !modelAvailable ? "请先选择模型" : generating ? "生成进行中…" : "输入消息"}
              value={text}
              rows={2}
              disabled={generating}
              onChange={(event) => { setText(event.target.value); persistDraft(event.target.value); }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
                if (files.length) { event.preventDefault(); void uploadImages(files); }
              }}
            />
            {attachments.length ? <ComposerImages assets={attachments} onRemove={(id) => setAttachments((current) => current.filter((asset) => asset.id !== id))} /> : null}
            {attachments.length && !imageConfigured ? <p className="composer-warning">当前模型不支持图片，Agent 也未配置备用识图模型。</p> : null}
            <div className="composer-toolbar">
              <label className="compact-select agent-select"><Bot size={15} /><select aria-label="选择 Agent" value={effectiveAgentId} disabled={generating || sending} onChange={(event) => chooseAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><ChevronDown size={13} /></label>
              <ModelPicker
                effectiveModelId={effectiveModelId}
                explicitValue={explicitModel === undefined ? INHERIT : explicitModel ?? NO_MODEL}
                agentModelId={effectiveAgent?.execution.modelId ?? null}
                models={models}
                connections={connections}
                disabled={generating || sending}
                onChange={chooseModel}
              />
              <label className="compact-select reasoning-select"><Gauge size={15} /><select aria-label="推理档位" value={overrides.reasoningEffort ?? INHERIT} disabled={generating || sending} onChange={(event) => chooseReasoning(event.target.value)}><option value={INHERIT}>跟随 Agent · {reasoning}</option>{REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select><ChevronDown size={13} /></label>
              <input ref={imageInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(event) => { void uploadImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button className="composer-tool-button icon-only" onClick={() => imageInputRef.current?.click()} disabled={generating || sending || uploading || attachments.length >= 4} aria-label="添加图片" title="添加图片">{uploading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}</button>
              <button className="composer-tool-button" onClick={() => setPickingWorkspace(true)} disabled={generating || sending} aria-label="选择工作目录" title={workspace ?? "选择工作目录"}><FolderOpen size={16} /><span>{workspace ? shortPath(workspace) : "目录"}</span></button>
              <button className="composer-tool-button icon-only" onClick={() => setEditingOverrides(true)} disabled={generating || sending} aria-label="高级执行设置" title="高级执行设置"><Settings2 size={16} />{Object.keys(overrides).length ? <b>{Object.keys(overrides).length}</b> : null}</button>
              <span className="grow" />
              {generating && active ? (
                <button className="send-button stop" onClick={() => void endpoints.cancelGeneration(active.generation.id).catch(toastError)} aria-label="停止生成"><Square size={17} fill="currentColor" /></button>
              ) : (
                <button className="send-button" onClick={() => void sendMessage()} disabled={sending || uploading || (!text.trim() && !attachments.length) || !effectiveAgent || !modelAvailable || (attachments.length > 0 && !imageConfigured)} aria-label="发送"><Send size={18} /></button>
              )}
            </div>
          </>
        )}
      </div>
      <p className="composer-hint">Enter 发送 · Shift+Enter 换行{explicitModel !== undefined ? " · 当前会话已覆盖 Agent 模型" : ""}</p>

      {pickingWorkspace ? <DirectoryPicker initialPath={workspace} onClose={() => setPickingWorkspace(false)} onSelect={(path) => void chooseWorkspace(path)} /> : null}
      {editingOverrides ? <ExecutionOverridesModal value={overrides} agent={effectiveAgent} models={models} onClose={() => setEditingOverrides(false)} onSave={async (next) => { await saveOverrides(next, "执行设置已保存"); setEditingOverrides(false); }} /> : null}
      {pendingAgent ? (
        <Modal title="切换 Agent" onClose={() => setPendingAgent(null)} footer={<><button className="button secondary" onClick={() => setPendingAgent(null)}>取消</button><button className="button primary" onClick={() => void applyAgent(pendingAgent)}>切换</button></>}>
          <p>历史消息会保留；后续回复使用新 Agent。当前会话的模型、上下文、推理和工具覆盖将全部清除。</p>
        </Modal>
      ) : null}
    </div>
  );
}

function ModelPicker({ effectiveModelId, explicitValue, agentModelId, models, connections, disabled, onChange }: {
  effectiveModelId: string | null;
  explicitValue: string;
  agentModelId: string | null;
  models: ModelDto[];
  connections: ConnectionDto[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [balances, setBalances] = useState<Record<string, ConnectionBalanceDto | "loading" | "error">>({});
  const effective = models.find((model) => model.id === effectiveModelId);
  const eligible = models.filter((model) => model.enabled && connections.some((connection) => connection.id === model.connectionId));
  const normalized = query.trim().toLocaleLowerCase();
  const groups = connections.map((connection) => ({
    connection,
    models: eligible.filter((model) => model.connectionId === connection.id && [model.displayName, model.modelKey, connection.name, connection.protocol].join(" ").toLocaleLowerCase().includes(normalized))
  })).filter((group) => group.models.length);

  useEffect(() => {
    if (!open) return;
    for (const connection of connections) {
      if (!connection.balanceConfig?.enabled || balances[connection.id]) continue;
      setBalances((current) => ({ ...current, [connection.id]: "loading" }));
      void endpoints.connectionBalance(connection.id).then((result) => setBalances((current) => ({ ...current, [connection.id]: result }))).catch(() => setBalances((current) => ({ ...current, [connection.id]: "error" })));
    }
  }, [open, connections]);

  return (
    <Popover.Root open={open} onOpenChange={(value) => { setOpen(value); if (!value) setQuery(""); }}>
      <Popover.Trigger asChild>
        <button className="model-trigger" disabled={disabled} aria-label="选择模型" title="选择模型"><span className="model-mark">M</span><span>{effective?.displayName ?? "选择模型"}</span><ChevronDown size={13} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="picker-popover model-picker" side="top" align="start" sideOffset={10}>
          <header><div><strong>模型</strong><span>仅影响当前会话</span></div><button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭模型选择"><X size={15} /></button></header>
          <label className="search-field"><Search size={15} /><input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型、连接或协议" aria-label="搜索模型" /></label>
          <div className="picker-list">
            <button className="model-option" data-selected={explicitValue === INHERIT || undefined} onClick={() => { onChange(INHERIT); setOpen(false); }}>
              <Bot size={18} /><span><strong>跟随 Agent</strong><small>{models.find((model) => model.id === agentModelId)?.displayName ?? "Agent 未配置模型"}</small></span>{explicitValue === INHERIT ? <Check size={15} /> : null}
            </button>
            {groups.map(({ connection, models: items }) => (
              <section className="model-group" key={connection.id}>
                <h3><span>{connection.name}</span><small>{connection.protocol}</small><Balance value={balances[connection.id]} /></h3>
                {items.map((model) => <button className="model-option" key={model.id} data-selected={effectiveModelId === model.id || undefined} onClick={() => { onChange(model.id); setOpen(false); }}><span className="model-mark">M</span><span><strong>{model.displayName}</strong><small>{model.modelKey}</small></span><span className="model-badges">{model.capabilities.imageInput ? <i>图片</i> : null}{model.capabilities.tools ? <i>工具</i> : null}{model.capabilities.reasoning ? <i>推理</i> : null}</span>{effectiveModelId === model.id ? <Check size={15} /> : null}</button>)}
              </section>
            ))}
            {!groups.length ? <div className="picker-empty">没有匹配的可用模型</div> : null}
          </div>
          <button className="picker-footer" onClick={() => { setOpen(false); navigate(routes.settings("connections")); }}><Settings2 size={15} />管理连接与模型</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Balance({ value }: { value: ConnectionBalanceDto | "loading" | "error" | undefined }) {
  if (!value) return null;
  if (value === "loading") return <RefreshCw size={12} className="spin" />;
  if (value === "error") return <small className="danger-text">余额失败</small>;
  return <small>余额 {new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value.value)}</small>;
}

function ApprovalQueue({ conversation, item, count, onInspect }: {
  conversation: ConversationDto;
  item: { message: MessageDto; generation: GenerationDto; call: ToolCallDto };
  count: number;
  onInspect: (target: InspectionTarget) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolve = async (approved: boolean) => {
    setBusy(true); setError("");
    try {
      const result = await endpoints.resolveToolCall(item.call.id, approved, approved ? undefined : reason.trim() || undefined);
      await loadMessages(conversation.id);
      trackGeneration(conversation.id, item.message.id, result.generationId);
      setDenying(false); setReason("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "审批失败"); } finally { setBusy(false); }
  };
  return (
    <section className="approval-queue" aria-label="工具审批">
      <header><Wrench size={17} /><div><strong>{item.call.name}</strong><span>第 1 项，共 {count} 项</span></div><button className="icon-button" onClick={() => onInspect({ kind: "tool", messageId: item.message.id, generationId: item.generation.id, toolCallId: item.call.id })} aria-label="检查工具调用"><Settings2 size={15} /></button></header>
      <pre>{prettyJson(item.call.arguments)}</pre>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {denying ? <label><span>拒绝原因（可选）</span><input className="input" value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label> : null}
      <footer>
        {denying ? <><button className="button secondary" onClick={() => setDenying(false)} disabled={busy}>返回</button><button className="button danger" onClick={() => void resolve(false)} disabled={busy}>确认拒绝</button></> : <><button className="button secondary" onClick={() => setDenying(true)} disabled={busy}>拒绝</button><button className="button primary" onClick={() => void resolve(true)} disabled={busy}>允许</button></>}
      </footer>
    </section>
  );
}

function ExecutionOverridesModal({ value, agent, models, onClose, onSave }: {
  value: ConversationExecutionOverrides;
  agent: AgentSummaryDto | undefined;
  models: ModelDto[];
  onClose: () => void;
  onSave: (value: ConversationExecutionOverrides) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConversationExecutionOverrides>(() => structuredClone(value));
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [toolQuery, setToolQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const common = draft.generation?.common ?? {};
  const protocol = draft.generation?.protocol ?? {};
  useEffect(() => { void endpoints.toolCatalog().then(setCatalog).catch(toastError); }, []);

  const setTop = (key: "modelId" | "contextPolicy" | "reasoningEffort", next: string) => setDraft((current) => {
    const output = structuredClone(current);
    if (next === INHERIT) delete output[key];
    else if (key === "modelId") output.modelId = next === NO_MODEL ? null : next;
    else if (key === "contextPolicy") output.contextPolicy = next as ContextPolicy;
    else output.reasoningEffort = next as ReasoningEffort;
    return output;
  });
  const setCommon = (key: "temperature" | "topP" | "maxOutputTokens" | "stopSequences", next: number | string[] | undefined) => setDraft((current) => withGenerationValue(current, "common", key, next));
  const setProtocol = (key: "reasoningSummary" | "thinkingBudgetTokens", next: string | number | undefined) => setDraft((current) => withGenerationValue(current, "protocol", key, next));
  const setTool = (name: string, next: string) => setDraft((current) => {
    const tools = { ...(current.tools ?? {}) };
    if (next === INHERIT) delete tools[name]; else tools[name] = next === "on";
    const output = { ...current };
    if (Object.keys(tools).length) output.tools = tools; else delete output.tools;
    return output;
  });
  const visibleTools = catalog.filter((tool) => [tool.label, tool.name, tool.description, tool.sourceName].filter(Boolean).join(" ").toLocaleLowerCase().includes(toolQuery.trim().toLocaleLowerCase()));
  const save = async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } };

  return (
    <Modal title="会话执行设置" onClose={onClose} wide footer={<><button className="button secondary" disabled={saving || !Object.keys(draft).length} onClick={() => setDraft({})}>清除覆盖</button><span className="grow" /><button className="button secondary" onClick={onClose} disabled={saving}>取消</button><button className="button primary" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</button></>}>
      <div className="override-editor">
        <p className="muted small">仅影响当前会话的后续生成。设为“跟随 Agent”会删除对应覆盖字段。</p>
        <div className="form-grid">
          <label className="field"><span>模型</span><select className="select" aria-label="会话模型覆盖" value={Object.hasOwn(draft, "modelId") ? draft.modelId ?? NO_MODEL : INHERIT} onChange={(event) => setTop("modelId", event.target.value)}><option value={INHERIT}>跟随 Agent · {models.find((model) => model.id === agent?.execution.modelId)?.displayName ?? "未配置"}</option><option value={NO_MODEL}>明确不使用模型</option>{models.filter((model) => model.enabled).map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.modelKey}</option>)}</select></label>
          <label className="field"><span>上下文策略</span><select className="select" aria-label="上下文策略" value={draft.contextPolicy ?? INHERIT} onChange={(event) => setTop("contextPolicy", event.target.value)}><option value={INHERIT}>跟随 Agent · {agent?.execution.contextPolicy ?? "auto"}</option>{CONTEXT_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}</select></label>
          <label className="field"><span>推理档位</span><select className="select" aria-label="推理档位" value={draft.reasoningEffort ?? INHERIT} onChange={(event) => setTop("reasoningEffort", event.target.value)}><option value={INHERIT}>跟随 Agent · {agent?.execution.reasoningEffort ?? "none"}</option>{REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
        </div>
        <h4>通用生成参数</h4>
        <div className="form-grid">
          <OptionalNumber label="温度" value={common.temperature} min={0} max={2} step={0.1} onChange={(next) => setCommon("temperature", next)} />
          <OptionalNumber label="Top P" value={common.topP} min={0} max={1} step={0.05} onChange={(next) => setCommon("topP", next)} />
          <OptionalNumber label="最大输出 token" value={common.maxOutputTokens} min={1} max={1_000_000} step={1} onChange={(next) => setCommon("maxOutputTokens", next)} />
          <label className="field span-2"><span>停止序列（每行一个）</span><textarea className="textarea" aria-label="停止序列（每行一个）" placeholder="留空表示继承；勾选后可覆盖为空列表" disabled={common.stopSequences === undefined} value={(common.stopSequences ?? []).join("\n")} onChange={(event) => setCommon("stopSequences", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /><label className="check-row"><input type="checkbox" checked={common.stopSequences !== undefined} onChange={(event) => setCommon("stopSequences", event.target.checked ? [] : undefined)} />覆盖停止序列</label></label>
        </div>
        <h4>协议参数</h4>
        <div className="form-grid">
          <label className="field"><span>推理摘要</span><select className="select" aria-label="推理摘要" value={protocol.reasoningSummary ?? INHERIT} onChange={(event) => setProtocol("reasoningSummary", event.target.value === INHERIT ? undefined : event.target.value)}><option value={INHERIT}>继承</option><option value="auto">auto</option><option value="concise">concise</option><option value="detailed">detailed</option></select></label>
          <OptionalNumber label="Thinking 预算（token）" value={protocol.thinkingBudgetTokens} min={1024} step={1} onChange={(next) => setProtocol("thinkingBudgetTokens", next)} />
        </div>
        <div className="tool-override-heading"><div><h4>工具覆盖</h4><p className="muted small">只改变工具是否启用，审批策略仍由 Agent 决定。</p></div><label className="search-field compact"><Search size={14} /><input type="search" aria-label="搜索工具" placeholder="搜索工具" value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} /></label></div>
        <div className="tool-override-list">{visibleTools.map((tool) => { const state = draft.tools?.[tool.name]; return <div className="tool-override-row" key={tool.name}><div><strong>{tool.label}</strong><code>{tool.name}</code><small>{tool.description}</small></div><StatusTag status={tool.available ? "completed" : "failed"} /><select className="select" aria-label={`${tool.label} 覆盖`} value={state === undefined ? INHERIT : state ? "on" : "off"} onChange={(event) => setTool(tool.name, event.target.value)}><option value={INHERIT}>跟随 Agent</option><option value="on">启用</option><option value="off">停用</option></select></div>; })}</div>
      </div>
    </Modal>
  );
}

function OptionalNumber({ label, value, min, max, step, onChange }: { label: string; value: number | undefined; min?: number; max?: number; step?: number; onChange: (value: number | undefined) => void }) {
  return <label className="field"><span>{label}</span><input className="input" type="number" aria-label={label} value={value ?? ""} min={min} max={max} step={step} placeholder="继承" onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} /></label>;
}

function EditForkModal({
  message,
  busy,
  onClose,
  onSubmit
}: {
  message: MessageDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(message.text ?? "");
  const valid = text.trim().length > 0 && text.length <= 1_000_000;
  return (
    <Modal
      title="编辑并分叉"
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary" onClick={() => void onSubmit(text)} disabled={busy || !valid}>
            {busy ? "正在创建…" : "创建分支并生成"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>修改后的消息</span>
        <textarea
          className="textarea edit-fork-input"
          aria-label="修改后的消息"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
        />
      </label>
      <p className="small muted edit-fork-note">保存后会立即在新分支生成回复。原消息和原会话保持不变。</p>
    </Modal>
  );
}

function withGenerationValue(current: ConversationExecutionOverrides, group: "common" | "protocol", key: string, next: unknown): ConversationExecutionOverrides {
  const output = structuredClone(current);
  const generation = { ...(output.generation ?? {}) };
  const values = { ...(generation[group] ?? {}) } as Record<string, unknown>;
  if (next === undefined) delete values[key]; else values[key] = next;
  if (Object.keys(values).length) generation[group] = values as never; else delete generation[group];
  if (Object.keys(generation).length) output.generation = generation; else delete output.generation;
  return output;
}

function AgentAvatar({ agent, label = "AI", size }: { agent?: AgentSummaryDto | undefined; label?: string; size?: "large" }) {
  const className = size === "large" ? "agent-avatar large" : "agent-avatar";
  if (agent?.hasAvatar) return <span className={className}><img src={`/api/agents/${agent.id}/avatar?t=${agent.updatedAt}`} alt="" /></span>;
  return <span className={className} aria-hidden="true">{(agent?.name ?? label).slice(0, 1)}</span>;
}

function IconAction({ label, onClick, danger, disabled, children }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  return <button className={`message-action${danger ? " danger" : ""}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}>{children}</button>;
}

function activeGeneration(message: MessageDto): GenerationDto | null {
  return message.generations.find((item) => item.id === message.activeGenerationId) ?? message.generations.at(-1) ?? null;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || "/";
}

function prettyJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
  toast("success", "已复制");
}

export { activeGeneration, prettyJson };
