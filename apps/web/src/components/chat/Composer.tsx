import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "radix-ui";
import {
  FolderOpen,
  Drama,
  Gauge,
  LoaderCircle,
  Minimize2,
  MoreHorizontal,
  Send,
  Settings2,
  Zap,
  Wrench,
  X
} from "lucide-react";
import type {
  ConversationDto,
  ConversationExecutionOverrides,
  ConversationRoleplayState,
  AgentDto,
  GenerationDto,
  MessageDto,
  ReasoningEffort,
  ToolCallDto
} from "@llm-chat/contracts";
import { ApiRequestError, endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, refreshConversations, restartGenerationTracking, toast, toastError, trackGeneration } from "../../lib/app-state";
import type { InspectionTarget } from "../../lib/inspection";
import { navigate, routes } from "../../lib/router";
import { useStore } from "../../lib/store";
import { Button } from "../ui";
import { DirectoryPicker } from "../DirectoryPicker";
import { AgentSwitchDialog, ExecutionOverridesDialog } from "./dialogs";
import { EMPTY_MESSAGES, INHERIT, NO_MODEL, REASONING_LEVELS, greetingOptions, prettyJson, shortPath } from "./model";
import { CancelGenerationButton } from "./CancelGenerationButton";
import { ModelPicker } from "./ModelPicker";
import { AgentPicker } from "./AgentPicker";
import { AttachmentMenu, AttachmentList, useAttachments } from "./AttachmentEditor";
import { ReasoningPicker } from "./ReasoningPicker";
import { useMessageQueue, MessageQueueList } from "./MessageQueueList";

const DRAFT_DEBOUNCE_MS = 500;

/**
 * The composer owns everything about the *next* turn: what to say, which Agent
 * and model answer it, per-conversation overrides, image attachments, and the
 * approval gate and messages queued for subsequent turns.
 */
export function Composer({
  conversation,
  onInspect,
  onBeforeSend,
  greetingIndex,
  onGreetingIndexChange,
  onPreviewAgentChange,
  compacting,
  canCompact,
  onCompact,
  roleplayAvailable = false,
  roleplayAgent = null,
  roleplayState = null,
  onRoleplayStateChange = () => undefined,
  onOpenRoleplay = () => undefined
}: {
  conversation: ConversationDto | null;
  onInspect: (target: InspectionTarget) => void;
  onBeforeSend: () => void;
  greetingIndex: number;
  onGreetingIndexChange: (index: number) => void;
  onPreviewAgentChange: (agentId: string | null) => void;
  compacting: boolean;
  canCompact: boolean;
  onCompact: () => void;
  roleplayAvailable?: boolean;
  roleplayAgent?: AgentDto | null;
  roleplayState?: ConversationRoleplayState | null;
  onRoleplayStateChange?: (state: ConversationRoleplayState) => void;
  onOpenRoleplay?: () => void;
}) {
  const settings = useStore(appStore, (state) => state.settings);
  const agents = useStore(appStore, (state) => state.agents);
  const models = useStore(appStore, (state) => state.models);
  const connections = useStore(appStore, (state) => state.connections);
  const messages = useStore(appStore, (state) =>
    conversation ? state.messages[conversation.id] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );

  const [text, setText] = useState("");
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [newOverrides, setNewOverrides] = useState<ConversationExecutionOverrides>({});
  const [newWorkspace, setNewWorkspace] = useState<string | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [editingOverrides, setEditingOverrides] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { attachments, setAttachments, uploading, uploadFiles } = useAttachments([], conversation?.id);
  const { items: queuedMessages, reload: reloadQueue } = useMessageQueue(conversation?.id);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedConversation = useRef<string | null>(null);
  const wasGenerating = useRef(false);
  const currentDraft = useRef("");
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
    onGreetingIndexChange(0);
    onPreviewAgentChange(null);
  }, [conversation?.id]);

  /* Effective execution context — conversation wins, then local pre-send state. */
  const fallbackAgent =
    agents.find((agent) => agent.id === settings?.lastAgentId) ??
    agents.find((agent) => agent.id === settings?.defaultAgentId) ??
    agents[0];
  const effectiveAgentId = conversation?.agentId ?? newAgentId ?? fallbackAgent?.id ?? "";
  const effectiveAgent = agents.find((agent) => agent.id === effectiveAgentId);
  const overrides = conversation?.executionOverrides ?? newOverrides;
  const explicitModel = Object.hasOwn(overrides, "modelId") ? overrides.modelId : undefined;
  const effectiveModelId =
    conversation?.modelId ?? (explicitModel !== undefined ? explicitModel : effectiveAgent?.execution.modelId) ?? null;
  const effectiveModel = models.find((model) => model.id === effectiveModelId);
  const modelAvailable = Boolean(
    effectiveModel?.enabled && connections.some((connection) => connection.id === effectiveModel.connectionId)
  );
  const visionModel = models.find((model) => model.id === effectiveAgent?.execution.visionModelId);
  const imageConfigured = Boolean(
    effectiveModel?.capabilities.imageInput || (visionModel?.enabled && visionModel.capabilities.imageInput)
  );
  const reasoning = overrides.reasoningEffort ?? effectiveAgent?.execution.reasoningEffort ?? settings?.reasoningEffort ?? "none";
  const advertisedReasoning = effectiveModel?.catalogMetadata?.reasoningEfforts ?? [];
  const reasoningLevels: ReasoningEffort[] = effectiveModel && !effectiveModel.capabilities.reasoning ? ["none"] : advertisedReasoning.length > 0
    ? advertisedReasoning
    : REASONING_LEVELS;
  const workspace = conversation?.workspacePath ?? newWorkspace;
  const greetings = effectiveAgent && settings ? greetingOptions(effectiveAgent, settings) : [];
  const quickReplies = roleplayAgent && roleplayState
    ? roleplayAgent.roleplay.quickReplySets
        .filter((set) => set.enabled && roleplayState.enabledQuickReplySetIds.includes(set.id))
        .flatMap((set) => set.replies)
        .filter((reply) => reply.enabled)
    : [];

  useEffect(() => {
    if (!isNew) return;
    onPreviewAgentChange(effectiveAgent?.id ?? null);
    if (greetings.length && !greetings.some((item) => item.sourceIndex === greetingIndex)) {
      onGreetingIndexChange(greetings[0]!.sourceIndex);
    }
  }, [isNew, effectiveAgent?.id, greetingIndex, greetings.length]);

  const active = messages
    .flatMap((message) => message.generations.map((generation) => ({ message, generation })))
    .find(({ generation }) => isGenerationActive(generation.status));
  const generating = Boolean(active && active.generation.status !== "waiting-approval");
  const pendingApprovals = messages
    .flatMap((message) =>
      message.generations.flatMap((generation) =>
        generation.toolCalls
          .filter((call) => call.approvalState === "pending")
          .map((call) => ({ message, generation, call }))
      )
    )
    .sort((left, right) => left.call.index - right.call.index);

  currentDraft.current = text;
  useEffect(() => {
    if (active) {
      wasGenerating.current = true;
      return;
    }
    if (!wasGenerating.current) return;
    wasGenerating.current = false;
    if (!conversation || !quickReplies.some((reply) =>
      reply.mode === "script" && reply.autoTriggers.includes("after_reply")
    )) return;
    const draft = currentDraft.current;
    void endpoints.executeRoleplayScript(conversation.id, { trigger: "after_reply", draft })
      .then((result) => {
        onRoleplayStateChange(result.state);
        if (result.draft !== draft) { setText(result.draft); persistDraft(result.draft); }
        for (const line of result.output.slice(-3)) toast("info", line);
      })
      .catch(toastError);
  }, [active?.generation.id, conversation?.id]);

  /** Drafts are stored server-side, but only after the reader pauses typing. */
  const persistDraft = (value: string) => {
    if (!conversation) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void endpoints.updateConversation(conversation.id, { draft: value }).catch(() => undefined);
    }, DRAFT_DEBOUNCE_MS);
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
    } catch (error) {
      toastError(error);
      throw error;
    }
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
      const selected = agents.find((item) => item.id === agentId);
      const firstGreeting = selected && settings ? greetingOptions(selected, settings)[0]?.sourceIndex ?? 0 : 0;
      onGreetingIndexChange(firstGreeting);
      onPreviewAgentChange(agentId);
      return;
    }
    try {
      await endpoints.updateConversation(conversation.id, { agentId });
      await refreshConversations();
      setPendingAgent(null);
    } catch (error) {
      toastError(error);
    }
  };

  /** Switching mid-conversation drops every override, so it needs confirming. */
  const chooseAgent = (agentId: string) => {
    if (agentId === effectiveAgentId) return;
    if (conversation && messages.length) setPendingAgent(agentId);
    else void applyAgent(agentId);
  };

  const chooseWorkspace = async (path: string | null) => {
    setPickingWorkspace(false);
    if (!conversation) {
      setNewWorkspace(path);
      return;
    }
    try {
      await endpoints.updateConversation(conversation.id, { workspacePath: path });
      await refreshConversations();
      toast("success", path ? "工作目录已更新" : "工作目录已清除");
    } catch (error) {
      toastError(error);
    }
  };

  const sendMessage = async (overrideText?: string) => {
    let content = (overrideText ?? text).trim();
    if ((!content && !attachments.length) || sending || uploading) return;
    if (!effectiveAgent) {
      toast("error", "请先选择一个 Agent");
      return;
    }
    if (!modelAvailable) {
      toast("error", "请先选择一个可用模型");
      return;
    }
    if (attachments.some((asset) => asset.kind === "image") && !imageConfigured) {
      toast("error", "当前模型不支持图片，请先为 Agent 配置备用识图模型");
      return;
    }
    onBeforeSend();
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    setSending(true);
    try {
      if (conversation && roleplayAgent && roleplayState && quickReplies.some((reply) =>
        reply.mode === "script" && reply.autoTriggers.includes("before_send")
      )) {
        const automated = await endpoints.executeRoleplayScript(conversation.id, { trigger: "before_send", draft: content });
        onRoleplayStateChange(automated.state);
        content = (automated.sendText ?? automated.draft ?? content).trim();
      }
      if (!content && !attachments.length) {
        toast("error", "发送前脚本清空了消息");
        return;
      }
      if (!conversation) {
        const result = await endpoints.startConversation({
          text: content,
          ...(attachments.length ? { assetIds: attachments.map((asset) => asset.id) } : {}),
          agentId: effectiveAgent.id,
          greetingIndex,
          executionOverrides: newOverrides,
          workspacePath: newWorkspace
        });
        if (effectiveAgent.roleplayEnabled) {
          await endpoints.executeRoleplayScript(result.conversation.id, { trigger: "new_chat", draft: "" })
            .catch(() => undefined);
        }
        setText("");
        setAttachments([]);
        await refreshConversations();
        await loadMessages(result.conversation.id);
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
        navigate(routes.chat(result.conversation.id));
      } else if (active || queuedMessages.some((item) => item.status !== "failed")) {
        await endpoints.enqueueMessage(conversation.id, content, attachments.map((asset) => asset.id));
        setText(""); setAttachments([]); persistDraft("");
        await reloadQueue();
      } else {
        const result = await endpoints.sendMessage(conversation.id, content, attachments.map((asset) => asset.id)).catch(async (error) => {
          if (!(error instanceof ApiRequestError) || error.code !== "conversation_busy") throw error;
          // Another device may have started a turn since this client's last snapshot.
          await endpoints.enqueueMessage(conversation.id, content, attachments.map((asset) => asset.id));
          await reloadQueue();
          return null;
        });
        setText("");
        setAttachments([]);
        persistDraft("");
        await loadMessages(conversation.id);
        if (result) trackGeneration(conversation.id, result.assistantMessageId, result.generationId);
        await refreshConversations();
      }
    } catch (error) {
      toastError(error);
    } finally {
      setSending(false);
    }
  };

  const useQuickReply = async (reply: (typeof quickReplies)[number]) => {
    if (controlsDisabled) return;
    if (reply.mode === "insert") {
      const next = text ? `${text}${text.endsWith("\n") ? "" : "\n"}${reply.content}` : reply.content;
      setText(next); persistDraft(next); return;
    }
    if (reply.mode === "send") {
      void sendMessage(reply.content); return;
    }
    if (!conversation) {
      toast("info", "受限脚本需要先创建会话"); return;
    }
    try {
      const result = await endpoints.executeRoleplayScript(conversation.id, { quickReplyId: reply.id, draft: text });
      setText(result.draft); persistDraft(result.draft); onRoleplayStateChange(result.state);
      for (const line of result.output.slice(-3)) toast("info", line);
      if (result.sendText) void sendMessage(result.sendText);
    } catch (error) { toastError(error); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const controlsDisabled = generating || sending;
  const sendDisabled =
    sending ||
    uploading ||
    (!text.trim() && !attachments.length) ||
    !effectiveAgent ||
    !modelAvailable ||
    (attachments.some((asset) => asset.kind === "image") && !imageConfigured);

  return (
    <div className="composer">
      <div className="composer-inner">
        <div
          className="composer-surface"
          onDragOver={(event) => {
            if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length) {
              event.preventDefault();
              if (!sending && !uploading) void uploadFiles(files);
            }
          }}
        >
          {pendingApprovals.length && conversation ? (
            <ApprovalCard
              conversationId={conversation.id}
              item={pendingApprovals[0]!}
              count={pendingApprovals.length}
              onInspect={onInspect}
            />
          ) : null}
            <>
              <textarea
                className="composer-input"
                aria-label="输入消息"
                placeholder={
                  !effectiveAgent ? "请先选择 Agent" : !modelAvailable ? "请先选择模型" : generating ? "输入下一条消息，加入队列" : "输入消息"
                }
                value={text}
                rows={2}
                disabled={sending}
                onChange={(event) => {
                  setText(event.target.value);
                  persistDraft(event.target.value);
                }}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.length) {
                    event.preventDefault();
                    void uploadFiles(files);
                  }
                }}
              />

              <AttachmentList attachments={attachments} setAttachments={setAttachments} disabled={uploading || sending} />
              {attachments.some((asset) => asset.kind === "image") && !imageConfigured ? (
                <p className="composer-warning">当前模型不支持图片，Agent 也未配置备用识图模型。</p>
              ) : null}
              {quickReplies.some((reply) => reply.pinned) ? (
                <div className="quick-reply-row" aria-label="快捷回复">
                  {quickReplies.filter((reply) => reply.pinned).map((reply) => (
                    <button type="button" className="quick-reply" key={reply.id} title={reply.tooltip || reply.label} onClick={() => void useQuickReply(reply)} disabled={controlsDisabled}>
                      {reply.mode === "script" ? <Zap size={13} aria-hidden="true" /> : null}{reply.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="composer-tools">
                <div className="composer-tool-scroll">
                  <AgentPicker agents={agents} value={effectiveAgentId} disabled={controlsDisabled} onChange={chooseAgent} />

                  <ModelPicker
                    effectiveModelId={effectiveModelId}
                    explicitValue={explicitModel === undefined ? INHERIT : explicitModel ?? NO_MODEL}
                    agentModelId={effectiveAgent?.execution.modelId ?? null}
                    models={models}
                    connections={connections}
                    disabled={controlsDisabled}
                    onChange={chooseModel}
                  />

                  <ReasoningPicker value={overrides.reasoningEffort ?? INHERIT} effective={reasoning}
                    inherited={effectiveAgent?.execution.reasoningEffort ?? settings?.reasoningEffort ?? "none"}
                    levels={reasoningLevels} disabled={controlsDisabled} onChange={chooseReasoning} />
                  <AttachmentMenu uploadFiles={uploadFiles} disabled={sending || attachments.length >= 8} uploading={uploading} />

                  <button
                    type="button"
                    className="chip composer-inline-tool"
                    onClick={() => setPickingWorkspace(true)}
                    disabled={controlsDisabled}
                    aria-label="选择工作目录"
                    title={workspace ?? "选择工作目录"}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span>{workspace ? shortPath(workspace) : "目录"}</span>
                  </button>
                  <button
                    type="button"
                    className="chip composer-inline-tool"
                    onClick={() => setEditingOverrides(true)}
                    disabled={controlsDisabled}
                    aria-label="高级执行设置"
                    title="高级执行设置"
                  >
                    <Settings2 size={16} aria-hidden="true" />
                    {Object.keys(overrides).length ? <b>{Object.keys(overrides).length}</b> : null}
                  </button>

                  <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
                    <Popover.Trigger asChild>
                      <button type="button" className="chip composer-more-trigger" aria-label="更多会话设置" title="更多">
                        <MoreHorizontal size={17} aria-hidden="true" />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content className="composer-more-popover" side="top" align="end" sideOffset={10}>
                        <div className="composer-more-mobile">
                          <button type="button" aria-label="选择工作目录" onClick={() => { setMoreOpen(false); setPickingWorkspace(true); }} disabled={controlsDisabled}>
                            <FolderOpen size={16} aria-hidden="true" />
                            <span><strong>工作目录</strong><small>{workspace ? shortPath(workspace) : "未选择"}</small></span>
                          </button>
                          <button type="button" aria-label="高级执行设置" onClick={() => { setMoreOpen(false); setEditingOverrides(true); }} disabled={controlsDisabled}>
                            <Settings2 size={16} aria-hidden="true" />
                            <span><strong>执行设置</strong><small>{Object.keys(overrides).length ? `${Object.keys(overrides).length} 项覆盖` : "跟随 Agent"}</small></span>
                          </button>
                        </div>
                        {roleplayAvailable ? (
                          <button type="button" aria-label="角色会话设置" onClick={() => { setMoreOpen(false); onOpenRoleplay(); }} disabled={controlsDisabled}>
                            <Drama size={16} aria-hidden="true" />
                            <span><strong>角色会话</strong><small>预设、人物、世界书与场景</small></span>
                          </button>
                        ) : null}
                        {quickReplies.filter((reply) => !reply.pinned).map((reply) => (
                          <button type="button" key={reply.id} title={reply.tooltip || reply.label} onClick={() => { setMoreOpen(false); void useQuickReply(reply); }} disabled={controlsDisabled}>
                            <Zap size={16} aria-hidden="true" />
                            <span><strong>{reply.label}</strong><small>{reply.mode === "insert" ? "插入草稿" : reply.mode === "send" ? "立即发送" : "受限脚本"}</small></span>
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label="立即压缩上下文"
                          onClick={() => { setMoreOpen(false); onCompact(); }}
                          disabled={controlsDisabled || compacting || !canCompact}
                          title={canCompact ? "立即压缩上下文" : "智能或摘要策略下，至少三轮对话后可压缩"}
                        >
                          {compacting ? <LoaderCircle className="spin" size={16} /> : <Minimize2 size={16} />}
                          <span><strong>压缩上下文</strong><small>{canCompact ? "立即生成会话摘要" : "当前不可用"}</small></span>
                        </button>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>

                {generating && active ? (
<CancelGenerationButton generationId={active.generation.id} className="send-button stop" />
                ) : null}
                  <button
                    type="button"
                    className="send-button"
                    onClick={() => void sendMessage()}
                    disabled={sendDisabled}
                    aria-label={active ? "加入队列" : "发送"}
                    title={active ? "本轮结束后按顺序发送" : "发送"}
                  >
                    <Send size={18} />
                  </button>
              </div>
            </>
        </div>
        <MessageQueueList conversationId={conversation?.id} items={queuedMessages} reload={reloadQueue} />
        <p className="composer-hint">Enter 发送 · Shift+Enter 换行</p>
      </div>

      {pickingWorkspace ? (
        <DirectoryPicker
          initialPath={workspace}
          onClose={() => setPickingWorkspace(false)}
          onSelect={(path) => void chooseWorkspace(path)}
        />
      ) : null}
      {editingOverrides ? (
        <ExecutionOverridesDialog
          value={overrides}
          agent={effectiveAgent}
          models={models}
          onClose={() => setEditingOverrides(false)}
          onSave={async (next) => {
            await saveOverrides(next, "执行设置已保存");
            setEditingOverrides(false);
          }}
        />
      ) : null}
      {pendingAgent ? (
        <AgentSwitchDialog onClose={() => setPendingAgent(null)} onConfirm={() => void applyAgent(pendingAgent)} />
      ) : null}
    </div>
  );
}

/**
 * Replaces the input while a tool call waits for approval — the reader cannot
 * send another turn until they allow or deny, so the choice is unmissable.
 */
function ApprovalCard({
  conversationId,
  item,
  count,
  onInspect
}: {
  conversationId: string;
  item: { message: MessageDto; generation: GenerationDto; call: ToolCallDto };
  count: number;
  onInspect: (target: InspectionTarget) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const resolve = async (approved: boolean) => {
    setBusy(true);
    setError("");
    try {
      const result = await endpoints.resolveToolCall(item.call.id, approved, approved ? undefined : reason.trim() || undefined);
      await loadMessages(conversationId);
      if (result.resumed) restartGenerationTracking(conversationId, item.message.id, result.generationId);
      setDenying(false);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "审批失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="approval-card" aria-label="工具审批">
      <header>
        <Wrench size={17} aria-hidden="true" />
        <div>
          <strong>{item.call.name}</strong>
          <span>第 1 项，共 {count} 项</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() =>
            onInspect({
              kind: "tool",
              messageId: item.message.id,
              generationId: item.generation.id,
              toolCallId: item.call.id
            })
          }
          aria-label="检查工具调用"
        >
          <Settings2 size={15} />
        </button>
      </header>
      <pre>{prettyJson(item.call.arguments)}</pre>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {denying ? (
        <label>
          <span>拒绝原因（可选）</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
        </label>
      ) : null}
      <footer>
        {denying ? (
          <>
            <Button onClick={() => setDenying(false)} disabled={busy}>
              返回
            </Button>
            <Button variant="danger" onClick={() => void resolve(false)} disabled={busy}>
              确认拒绝
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setDenying(true)} disabled={busy}>
              拒绝
            </Button>
            <Button variant="primary" onClick={() => void resolve(true)} disabled={busy}>
              允许
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
