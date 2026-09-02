import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bot,
  ChevronDown,
  FolderOpen,
  Gauge,
  ImagePlus,
  LoaderCircle,
  Send,
  Settings2,
  Square,
  Wrench,
  X
} from "lucide-react";
import type {
  ConversationDto,
  ConversationExecutionOverrides,
  GenerationDto,
  ImageAssetDto,
  MessageDto,
  ReasoningEffort,
  ToolCallDto
} from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, refreshConversations, toast, toastError, trackGeneration } from "../../lib/app-state";
import { fileToBase64 } from "../../lib/format";
import type { InspectionTarget } from "../../lib/inspection";
import { navigate, routes } from "../../lib/router";
import { useStore } from "../../lib/store";
import { Button } from "../ui";
import { DirectoryPicker } from "../DirectoryPicker";
import { AgentSwitchDialog, ExecutionOverridesDialog } from "./dialogs";
import { EMPTY_MESSAGES, INHERIT, NO_MODEL, REASONING_LEVELS, greetingOptions, prettyJson, shortPath } from "./model";
import { ModelPicker } from "./ModelPicker";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const DRAFT_DEBOUNCE_MS = 500;

/**
 * The composer owns everything about the *next* turn: what to say, which Agent
 * and model answer it, per-conversation overrides, image attachments, and the
 * approval gate that replaces the input while a tool waits for a decision.
 */
export function Composer({
  conversation,
  onInspect,
  onBeforeSend,
  greetingIndex,
  onGreetingIndexChange,
  onPreviewAgentChange
}: {
  conversation: ConversationDto | null;
  onInspect: (target: InspectionTarget) => void;
  onBeforeSend: () => void;
  greetingIndex: number;
  onGreetingIndexChange: (index: number) => void;
  onPreviewAgentChange: (agentId: string | null) => void;
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
  const reasoningLevels = advertisedReasoning.length > 0
    ? [...new Set([...advertisedReasoning, ...(overrides.reasoningEffort ? [overrides.reasoningEffort] : [])])]
    : REASONING_LEVELS;
  const workspace = conversation?.workspacePath ?? newWorkspace;
  const greetings = effectiveAgent && settings ? greetingOptions(effectiveAgent, settings) : [];

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

  /** Validate locally first: type, per-file size, total size, and slot count. */
  const uploadImages = async (files: File[]) => {
    if (!files.length || uploading) return;
    const slots = Math.max(0, MAX_IMAGES - attachments.length);
    if (!slots) {
      toast("error", `每条消息最多附加 ${MAX_IMAGES} 张图片`);
      return;
    }
    const selected = files.slice(0, slots);
    if (files.length > slots) toast("info", `只会添加前 ${slots} 张图片`);
    let totalBytes = attachments.reduce((sum, asset) => sum + asset.byteSize, 0);
    const accepted: File[] = [];
    for (const file of selected) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        toast("error", `${file.name || "图片"} 不是支持的图片格式`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast("error", `${file.name || "图片"} 超过 5 MiB`);
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        toast("error", "图片总大小不能超过 15 MiB");
        break;
      }
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
        return next.slice(0, MAX_IMAGES);
      });
    } catch (error) {
      toastError(error);
    } finally {
      setUploading(false);
    }
  };

  const sendMessage = async () => {
    const content = text.trim();
    if ((!content && !attachments.length) || sending || uploading || generating || pendingApprovals.length) return;
    if (!effectiveAgent) {
      toast("error", "请先选择一个 Agent");
      return;
    }
    if (!modelAvailable) {
      toast("error", "请先选择一个可用模型");
      return;
    }
    if (attachments.length && !imageConfigured) {
      toast("error", "当前模型不支持图片，请先为 Agent 配置备用识图模型");
      return;
    }
    onBeforeSend();
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
    } catch (error) {
      toastError(error);
    } finally {
      setSending(false);
    }
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
    (attachments.length > 0 && !imageConfigured);

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
              void uploadImages(files);
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
          ) : (
            <>
              <textarea
                className="composer-input"
                aria-label="输入消息"
                placeholder={
                  !effectiveAgent ? "请先选择 Agent" : !modelAvailable ? "请先选择模型" : generating ? "生成进行中…" : "输入消息"
                }
                value={text}
                rows={2}
                disabled={generating}
                onChange={(event) => {
                  setText(event.target.value);
                  persistDraft(event.target.value);
                }}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
                  if (files.length) {
                    event.preventDefault();
                    void uploadImages(files);
                  }
                }}
              />

              {attachments.length ? (
                <div className="composer-attachments" aria-label="待发送图片">
                  {attachments.map((asset) => (
                    <div key={asset.id} className="attachment-chip">
                      <img src={asset.url} alt={asset.fileName} />
                      <span>{asset.fileName}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((current) => current.filter((item) => item.id !== asset.id))}
                        aria-label={`移除 ${asset.fileName}`}
                        title="移除图片"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {attachments.length && !imageConfigured ? (
                <p className="composer-warning">当前模型不支持图片，Agent 也未配置备用识图模型。</p>
              ) : null}

              <div className="composer-tools">
                <div className="composer-tool-scroll">
                  <label className="chip chip-select">
                  <Bot size={15} aria-hidden="true" />
                  <select
                    aria-label="选择 Agent"
                    value={effectiveAgentId}
                    disabled={controlsDisabled}
                    onChange={(event) => chooseAgent(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} aria-hidden="true" />
                  </label>

                <ModelPicker
                  effectiveModelId={effectiveModelId}
                  explicitValue={explicitModel === undefined ? INHERIT : explicitModel ?? NO_MODEL}
                  agentModelId={effectiveAgent?.execution.modelId ?? null}
                  models={models}
                  connections={connections}
                  disabled={controlsDisabled}
                  onChange={chooseModel}
                />

                <label className="chip chip-select">
                  <Gauge size={15} aria-hidden="true" />
                  <select
                    aria-label="推理档位"
                    value={overrides.reasoningEffort ?? INHERIT}
                    disabled={controlsDisabled}
                    onChange={(event) => chooseReasoning(event.target.value)}
                  >
                    <option value={INHERIT}>跟随 Agent · {reasoning}</option>
                    {reasoningLevels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} aria-hidden="true" />
                </label>

                <input
                  ref={imageInputRef}
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  onChange={(event) => {
                    void uploadImages(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="chip"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={controlsDisabled || uploading || attachments.length >= MAX_IMAGES}
                  aria-label="添加图片"
                  title="添加图片"
                >
                  {uploading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                </button>
                <button
                  type="button"
                  className="chip"
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
                  className="chip"
                  onClick={() => setEditingOverrides(true)}
                  disabled={controlsDisabled}
                  aria-label="高级执行设置"
                  title="高级执行设置"
                >
                  <Settings2 size={16} aria-hidden="true" />
                  {Object.keys(overrides).length ? <b>{Object.keys(overrides).length}</b> : null}
                </button>

                </div>

                {generating && active ? (
                  <button
                    type="button"
                    className="send-button stop"
                    onClick={() => void endpoints.cancelGeneration(active.generation.id).catch(toastError)}
                    aria-label="停止生成"
                  >
                    <Square size={17} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="send-button"
                    onClick={() => void sendMessage()}
                    disabled={sendDisabled}
                    aria-label="发送"
                  >
                    <Send size={18} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <p className="composer-hint">
          Enter 发送 · Shift+Enter 换行{explicitModel !== undefined ? " · 当前会话已覆盖 Agent 模型" : ""}
        </p>
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
      trackGeneration(conversationId, item.message.id, result.generationId);
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
