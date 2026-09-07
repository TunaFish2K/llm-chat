import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "radix-ui";
import {
  Bot,
  ChevronDown,
  FolderOpen,
  FilePlus2,
  FileText,
  Drama,
  Gauge,
  ImagePlus,
  LoaderCircle,
  Minimize2,
  MoreHorizontal,
  Send,
  Settings2,
  Square,
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
  FileAssetDto,
  MessageDto,
  ReasoningEffort,
  ToolCallDto
} from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, refreshConversations, restartGenerationTracking, toast, toastError, trackGeneration } from "../../lib/app-state";
import type { InspectionTarget } from "../../lib/inspection";
import { navigate, routes } from "../../lib/router";
import { useStore } from "../../lib/store";
import { fileToBase64 } from "../../lib/format";
import { Field, Modal } from "../../lib/ui";
import { Button } from "../ui";
import { DirectoryPicker } from "../DirectoryPicker";
import { AgentSwitchDialog, ExecutionOverridesDialog } from "./dialogs";
import { EMPTY_MESSAGES, INHERIT, NO_MODEL, REASONING_LEVELS, greetingOptions, prettyJson, shortPath } from "./model";
import { ModelPicker } from "./ModelPicker";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
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
  const [attachments, setAttachments] = useState<FileAssetDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [imageSubmitting, setImageSubmitting] = useState(false);
  const [imagePromptOpen, setImagePromptOpen] = useState(false);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageModelId, setImageModelId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const imageModels = models.filter((model) => model.enabled && model.capabilities.imageOutput && model.imageProtocol);
  const imageModel = imageModels.find((model) => model.id === imageModelId)
    ?? imageModels.find((model) => model.id === effectiveModelId)
    ?? imageModels[0];
  const reasoning = overrides.reasoningEffort ?? effectiveAgent?.execution.reasoningEffort ?? settings?.reasoningEffort ?? "none";
  const advertisedReasoning = effectiveModel?.catalogMetadata?.reasoningEfforts ?? [];
  const reasoningLevels = advertisedReasoning.length > 0
    ? [...new Set([...advertisedReasoning, ...(overrides.reasoningEffort ? [overrides.reasoningEffort] : [])])]
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
  const uploadFiles = async (files: File[]) => {
    if (!files.length || uploading) return;
    const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (!slots) {
      toast("error", `每条消息最多附加 ${MAX_ATTACHMENTS} 个文件`);
      return;
    }
    const selected = files.slice(0, slots);
    if (files.length > slots) toast("info", `只会添加前 ${slots} 个文件`);
    let totalBytes = attachments.reduce((sum, asset) => sum + asset.byteSize, 0);
    let imageBytes = attachments.filter((asset) => asset.kind === "image").reduce((sum, asset) => sum + asset.byteSize, 0);
    let imageCount = attachments.filter((asset) => asset.kind === "image").length;
    const accepted: File[] = [];
    for (const file of selected) {
      const image = ACCEPTED_IMAGE_TYPES.has(file.type);
      if (image && file.size > MAX_IMAGE_BYTES) {
        toast("error", `${file.name || "图片"} 超过 5 MiB`);
        continue;
      }
      if (!image && file.size > MAX_FILE_BYTES) {
        toast("error", `${file.name || "文件"} 超过 64 MiB`);
        continue;
      }
      if (image && imageCount >= MAX_IMAGES) {
        toast("error", `每条消息最多附加 ${MAX_IMAGES} 张图片`);
        continue;
      }
      if (image && imageBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        toast("error", "图片总大小不能超过 15 MiB");
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_BYTES) {
        toast("error", "附件总大小不能超过 128 MiB");
        continue;
      }
      totalBytes += file.size;
      if (image) { imageBytes += file.size; imageCount += 1; }
      accepted.push(file);
    }
    if (!accepted.length) return;
    setUploading(true);
    try {
      const uploaded: FileAssetDto[] = [];
      for (const file of accepted) {
        const asset = ACCEPTED_IMAGE_TYPES.has(file.type)
          ? await endpoints.uploadImage(file.name || `pasted-image-${Date.now()}.png`, await fileToBase64(file))
          : await endpoints.uploadFile(file);
        uploaded.push({ ...asset, kind: asset.kind ?? (asset.mimeType.startsWith("image/") ? "image" : "file") });
      }
      setAttachments((current) => {
        const next = [...current];
        for (const asset of uploaded) if (!next.some((item) => item.id === asset.id)) next.push(asset);
        return next.slice(0, MAX_ATTACHMENTS);
      });
    } catch (error) {
      toastError(error);
    } finally {
      setUploading(false);
    }
  };

  const sendMessage = async (overrideText?: string) => {
    let content = (overrideText ?? text).trim();
    if ((!content && !attachments.length) || sending || uploading || generating || pendingApprovals.length) return;
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

  const generateImage = async () => {
    if (!conversation || !imageModel || controlsDisabled || imageSubmitting) return;
    if (!imagePrompt.trim()) return;
    setImageSubmitting(true);
    setImagePromptOpen(false);
    try {
      const job = await endpoints.startImageGeneration(conversation.id, {
        modelId: imageModel.id,
        prompt: imagePrompt.trim(),
        operation: "generate",
        referenceAssetIds: [],
        count: 1
      });
      setText("");
      setAttachments([]);
      persistDraft("");
      await loadMessages(conversation.id);
      toast("info", job.status === "completed" ? "图片已生成" : "图片任务已提交");
    } catch (error) {
      toastError(error);
    } finally {
      setImageSubmitting(false);
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

  const controlsDisabled = generating || sending || imageSubmitting;
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
              void uploadFiles(files);
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
                  const files = [...event.clipboardData.files];
                  if (files.length) {
                    event.preventDefault();
                    void uploadFiles(files);
                  }
                }}
              />

              {attachments.length ? (
                <div className="composer-attachments" aria-label="待发送附件">
                  {attachments.map((asset) => (
                    <div key={asset.id} className="attachment-chip">
                      {asset.kind === "image" ? <img src={asset.url} alt={asset.fileName} /> : <FileText size={20} aria-hidden="true" />}
                      <span>{asset.fileName}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((current) => current.filter((item) => item.id !== asset.id))}
                        aria-label={`移除 ${asset.fileName}`}
                        title="移除附件"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
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
                  <label className="chip chip-select composer-agent-select">
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

                  <label className="chip chip-select composer-inline-tool composer-reasoning-select">
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
                    ref={fileInputRef}
                    className="sr-only"
                    type="file"
                    multiple
                    onChange={(event) => {
                      void uploadFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="chip composer-attachment-button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={controlsDisabled || uploading || attachments.length >= MAX_ATTACHMENTS}
                    aria-label="添加附件"
                    title="添加附件"
                  >
                    {uploading ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}
                  </button>
                  <button
                    type="button"
                    className="chip composer-attachment-button"
                    onClick={() => {
                      setImagePrompt(text.trim());
                      setImageModelId(imageModel?.id ?? "");
                      setImagePromptOpen(true);
                    }}
                    disabled={controlsDisabled || !conversation || !imageModel}
                    aria-label="生成图片"
                    title={imageModel ? `使用 ${imageModel.displayName} 生成图片` : "没有可用的图片模型"}
                  >
                    {imageSubmitting ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                  </button>
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
                          <label className="composer-menu-field">
                            <span><Gauge size={15} aria-hidden="true" />推理档位</span>
                            <select
                              className="select"
                              aria-label="更多菜单中的推理档位"
                              value={overrides.reasoningEffort ?? INHERIT}
                              disabled={controlsDisabled}
                              onChange={(event) => chooseReasoning(event.target.value)}
                            >
                              <option value={INHERIT}>跟随 Agent · {reasoning}</option>
                              {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                            </select>
                          </label>
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
      {imagePromptOpen ? (
        <Modal
          title="生成图片"
          onClose={() => setImagePromptOpen(false)}
          footer={
            <>
              <Button onClick={() => setImagePromptOpen(false)} disabled={imageSubmitting}>取消</Button>
              <Button variant="primary" onClick={() => void generateImage()} disabled={imageSubmitting || !imagePrompt.trim() || !imageModel}>
                {imageSubmitting ? "提交中…" : "生成"}
              </Button>
            </>
          }
        >
          <Field label="图片模型">
            <select className="select" value={imageModel?.id ?? ""} onChange={(event) => setImageModelId(event.target.value)}>
              {imageModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
          </Field>
          <Field label="提示词" hint="描述主体、场景、风格和构图。">
            <textarea
              className="textarea"
              value={imagePrompt}
              onChange={(event) => setImagePrompt(event.target.value)}
              rows={5}
              autoFocus
            />
          </Field>
        </Modal>
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
