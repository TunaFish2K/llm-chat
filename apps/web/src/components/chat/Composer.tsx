import { effectiveReasoningSelection, legacyReasoningSelection, type ReasoningSelection } from "@llm-chat/contracts";
import { useErrorState } from "../../lib/error-display";
import { t, useLocale, localized } from "../../lib/i18n";
import { offlineStore } from "../../lib/offline-history";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
} from "@llm-chat/contracts";
import { useBackLayer } from "../../lib/mobile-navigation";
import { recoveredDraftIds, swapRecoveredDraft, readComposerDraft, writeComposerDraft, scheduleServerDraft, flushServerDraft, serializeModelSelection } from "../../lib/composer-drafts";
import { ApiRequestError, endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, refreshAgents, refreshConversations, restartGenerationTracking, toast, toastError, trackGeneration } from "../../lib/app-state";
import type { InspectionTarget } from "../../lib/inspection";
import { navigate, routes } from "../../lib/router";
import { useStore } from "../../lib/store";
import { Button } from "../ui";
import { DirectoryPicker } from "../DirectoryPicker";
import { AgentSwitchDialog, ExecutionOverridesDialog } from "./dialogs";
import { createComposerMessageSelector, type ComposerMessageState, EMPTY_MESSAGES, INHERIT, NO_MODEL, greetingOptions, prettyJson } from "./model";
import { ChatTypographySettings } from "../ChatTypographySettings";
import { CancelGenerationButton } from "./CancelGenerationButton";
import { ModelPicker } from "./ModelPicker";
import { AgentPicker } from "./AgentPicker";
import { AttachmentMenu, AttachmentList, useAttachments } from "./AttachmentEditor";
import { ReasoningPicker } from "./ReasoningPicker";
import { useMessageQueue, MessageQueueList } from "./MessageQueueList";
import { useComposerLayout } from "./useComposerLayout";
import { useHoldSend } from "./useHoldSend";


/**
 * The composer owns everything about the *next* turn: what to say, which Agent
 * and model answer it, per-conversation overrides, image attachments, and the
 * approval gate and messages queued for subsequent turns.
 */
export const Composer = memo(function Composer({
  actionsHost = null,
  mobile = false,
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
  actionsHost?: HTMLDivElement | null;
  mobile?: boolean;
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
  useLocale();
  const settings = useStore(appStore, (state) => state.settings);
  const agents = useStore(appStore, (state) => state.agents);
  const models = useStore(appStore, (state) => state.models);
  const connections = useStore(appStore, (state) => state.connections);
  const selectMessages = useMemo(() => createComposerMessageSelector(isGenerationActive), [conversation?.id]);
  const { messageCount, active, pendingApprovals } = useStore(appStore, (state) =>
    selectMessages(conversation ? state.messages[conversation.id] ?? EMPTY_MESSAGES : EMPTY_MESSAGES)
  );

  const [initialDraft] = useState(() => readComposerDraft(conversation?.id ?? null));
  const fallbackAgent =
    agents.find((agent) => agent.id === settings?.lastAgentId) ??
    agents.find((agent) => agent.id === settings?.defaultAgentId) ?? agents[0];
  const initialOverrides = (agentId: string | null, overrides: ConversationExecutionOverrides = {}) => {
    const agent = agents.find((item) => item.id === agentId) ?? fallbackAgent;
    const remembered = models.find((item) => item.id === agent?.lastSelectedModelId && item.enabled &&
      connections.some((connection) => connection.id === item.connectionId));
    return !Object.hasOwn(overrides, "modelId") && !agent?.execution.modelId && remembered
      ? { ...overrides, modelId: remembered.id } : overrides;
  };
  const explicitNewModel = useRef(Boolean(initialDraft && Object.hasOwn(initialDraft.overrides, "modelId")));
  const [text, setText] = useState(initialDraft?.text ?? conversation?.draft ?? "");
  const [newAgentId, setNewAgentId] = useState<string | null>(initialDraft?.agentId ?? null);
  const [newOverrides, setNewOverrides] = useState<ConversationExecutionOverrides>(() =>
    initialOverrides(initialDraft?.agentId ?? null, initialDraft?.overrides));
  const [newWorkspace, setNewWorkspace] = useState<string | null>(initialDraft ? initialDraft.workspace : settings?.lastWorkspacePath ?? null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [editingOverrides, setEditingOverrides] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const offline = useStore(offlineStore, (state) => state.offline);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typographyOpen, setTypographyOpen] = useState(false);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  useBackLayer(moreOpen, () => setMoreOpen(false));
  useBackLayer(settingsOpen, () => setSettingsOpen(false));
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [savingOverrides, setSavingOverrides] = useState(false);
  const { attachments, setAttachments, uploading, uploadFiles } = useAttachments(initialDraft?.attachments ?? [], conversation?.id);
  const { items: queuedMessages, paused: queuePaused, reload: reloadQueue } = useMessageQueue(conversation?.id);
  const wasGenerating = useRef(false);
  const currentDraft = useRef("");
  const isNew = !conversation;

  const effectiveAgentId = conversation?.agentId ?? newAgentId ?? fallbackAgent?.id ?? "";
  const effectiveAgent = agents.find((agent) => agent.id === effectiveAgentId);
  useLayoutEffect(() => {
    const savedOverrides = { ...(conversation?.executionOverrides ?? newOverrides) };
    if (!text && !attachments.length && !explicitNewModel.current) delete savedOverrides.modelId;
    writeComposerDraft(conversation?.id ?? null, {
      text, attachments, agentId: effectiveAgentId || null, overrides: savedOverrides,
      workspace: conversation ? conversation.workspacePath : newWorkspace, greetingIndex
    });
  }, [conversation?.id, text, attachments, effectiveAgentId, newOverrides, newWorkspace, greetingIndex]);
  useEffect(() => {
    if (conversation && initialDraft && initialDraft.text !== conversation.draft) {
      scheduleServerDraft(conversation.id, initialDraft.text);
    }
    return () => { if (conversation) void flushServerDraft(conversation.id).catch(() => undefined); };
  }, [conversation?.id]);

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
  const inheritedReasoning = effectiveReasoningSelection(effectiveAgent?.execution ?? {});
  const selectedReasoning = overrides.reasoningSelection ?? (overrides.reasoningEffort !== undefined ? legacyReasoningSelection(overrides.reasoningEffort) : undefined);
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

  const generating = !offline && Boolean(active && active.status !== "waiting-approval");
  useEffect(() => {
    if (conversation && !active) { void reloadQueue().catch(toastError); }
  }, [conversation?.id, active?.id, reloadQueue]);

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
  }, [active?.id, conversation?.id]);

  const persistDraft = (value: string) => {
    if (conversation) scheduleServerDraft(conversation.id, value);
  };

  const saveOverrides = async (next: ConversationExecutionOverrides, message?: string, explicitSelection = false) => {
    setSavingOverrides(true);
    if (!conversation) {
      if (explicitSelection || next.modelId !== overrides.modelId) explicitNewModel.current = Object.hasOwn(next, "modelId");
      setNewOverrides(initialOverrides(effectiveAgentId, next));
    }
    const remember = typeof next.modelId === "string" && (explicitSelection || next.modelId !== overrides.modelId);
    try {
      await serializeModelSelection(effectiveAgentId, async () => {
        if (conversation) {
          await endpoints.updateConversation(conversation.id, explicitSelection && typeof next.modelId === "string"
            ? { modelId: next.modelId } : { executionOverrides: next });
          await refreshConversations();
        } else if (remember) await endpoints.selectAgentModel(effectiveAgentId, next.modelId!);
        if (remember) await refreshAgents();
      });
      if (message) toast("success", message);
    } catch (error) {
      toastError(error);
      throw error;
    } finally { setSavingOverrides(false); }
  };

  const chooseModel = (value: string) => {
    const next = { ...overrides };
    if (value === INHERIT) delete next.modelId;
    else next.modelId = value;
    void saveOverrides(next, undefined, true).catch(() => undefined);
  };

  const chooseReasoning = (value: ReasoningSelection | undefined) => {
    const next = { ...overrides };
    delete next.reasoningEffort;
    if (value === undefined) delete next.reasoningSelection;
    else next.reasoningSelection = value;
    void saveOverrides(next).catch(() => undefined);
  };

  const applyAgent = async (agentId: string) => {
    if (!conversation) {
      explicitNewModel.current = false;
      setNewAgentId(agentId);
      setNewOverrides(initialOverrides(agentId));
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
    if (conversation && messageCount) setPendingAgent(agentId);
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
      toast("success", path ? t("Composer.working_directory_updated") : t("Composer.working_directory_cleared"));
    } catch (error) {
      toastError(error);
    }
  };

  const sendMessage = async (overrideText?: string, steer = false) => {
    let content = (overrideText ?? text).trim();
    if ((!content && !attachments.length) || sending || uploading || savingOverrides) return;
    if (!effectiveAgent) {
      toast("error", localized("Composer.select_an_agent_first"));
      return;
    }
    if (!modelAvailable) {
      toast("error", localized("Composer.select_an_available_model_first"));
      return;
    }
    if (attachments.some((asset) => asset.kind === "image") && !imageConfigured) {
      toast("error", localized("Composer.this_model_does_not_support_images_configure_a_fallback_vision"));
      return;
    }
    setSending(true);
    onBeforeSend();
    try {
      if (conversation) await flushServerDraft(conversation.id);
      if (conversation && roleplayAgent && roleplayState && quickReplies.some((reply) =>
        reply.mode === "script" && reply.autoTriggers.includes("before_send")
      )) {
        const automated = await endpoints.executeRoleplayScript(conversation.id, { trigger: "before_send", draft: content });
        onRoleplayStateChange(automated.state);
        content = (automated.sendText ?? automated.draft ?? content).trim();
      }
      if (!content && !attachments.length) {
        toast("error", localized("Composer.the_before_send_script_cleared_the_message"));
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
        setText("");
        setAttachments([]);
        explicitNewModel.current = false;
        setNewOverrides({});
        setNewAgentId(null);
        onGreetingIndexChange(0);
        appStore.set((state) => ({ settings: state.settings ? { ...state.settings, lastAgentId: effectiveAgent.id } : null }));
        if (effectiveAgent.roleplayEnabled) {
          await endpoints.executeRoleplayScript(result.conversation.id, { trigger: "new_chat", draft: "" })
            .catch(() => undefined);
        }
        await refreshConversations();
        await loadMessages(result.conversation.id);
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
        navigate(routes.chat(result.conversation.id));
      } else if (active || (!queuePaused && queuedMessages.some((item) => item.status !== "failed"))) {
        await endpoints.enqueueMessage(conversation.id, content, attachments.map((asset) => asset.id), steer ? "steer" : "queue");
        setText(""); setAttachments([]); persistDraft("");
        await reloadQueue();
      } else {
        const result = await endpoints.sendMessage(conversation.id, content, attachments.map((asset) => asset.id)).catch(async (error) => {
          if (!(error instanceof ApiRequestError) || error.code !== "conversation_busy") throw error;
          // Another device may have started a turn since this client's last snapshot.
          await endpoints.enqueueMessage(conversation.id, content, attachments.map((asset) => asset.id), steer ? "steer" : "queue");
          return null;
        });
        setText("");
        setAttachments([]);
        persistDraft("");
        if (!result) await reloadQueue();
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
  useLocale();
    if (controlsDisabled) return;
    if (reply.mode === "insert") {
      const next = text ? `${text}${text.endsWith("\n") ? "" : "\n"}${reply.content}` : reply.content;
      setText(next); persistDraft(next); return;
    }
    if (reply.mode === "send") {
      void sendMessage(reply.content); return;
    }
    if (!conversation) {
      toast("info", localized("Composer.create_a_conversation_before_running_sandboxed_scripts")); return;
    }
    try {
      const result = await endpoints.executeRoleplayScript(conversation.id, { quickReplyId: reply.id, draft: text });
      setText(result.draft); persistDraft(result.draft); onRoleplayStateChange(result.state);
      for (const line of result.output.slice(-3)) toast("info", line);
      if (result.sendText) void sendMessage(result.sendText);
    } catch (error) { toastError(error); }
  };

  const toolbar = useComposerLayout();
  const holdSend = useHoldSend((steer) => void sendMessage(undefined, steer), conversation?.id);
  const keyHoldSend = useHoldSend((steer) => void sendMessage(undefined, steer), conversation?.id);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!event.repeat) keyHoldSend.start();
    }
  };

  const controlsDisabled = offline || generating || sending || savingOverrides;
  const sendDisabled = offline ||
    sending || savingOverrides ||
    uploading ||
    (!text.trim() && !attachments.length) ||
    !effectiveAgent ||
    !modelAvailable ||
    (attachments.some((asset) => asset.kind === "image") && !imageConfigured);

  return (
    <div className="composer">
      <div className="composer-inner">
        {isNew && recoveredDraftIds().length > 0 && <button type="button" className="btn small" onClick={() => {
          const draft = swapRecoveredDraft();
          if (!draft) return;
          setText(draft.text); setAttachments(draft.attachments); setNewAgentId(draft.agentId);
          setNewOverrides(draft.overrides); setNewWorkspace(draft.workspace);
          explicitNewModel.current = Object.hasOwn(draft.overrides, "modelId");
          onGreetingIndexChange(draft.greetingIndex);
        }}>{t("Composer.switch_saved_draft")}</button>}
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
          {!offline && pendingApprovals.length && conversation ? (
            <ApprovalCard
              conversationId={conversation.id}
              item={pendingApprovals[0]!}
              count={pendingApprovals.length}
              onInspect={onInspect}
            />
          ) : null}
            <>
              <div className="composer-input-area" ref={inputAreaRef}>
              <textarea
                className="composer-input"
                aria-label={t("Composer.enter_a_message")}
                placeholder={
                  !effectiveAgent ? t("Composer.select_an_agent_first_2") : !modelAvailable ? t("Composer.select_a_model_first") : t("Composer.type_a_message")
                }
                value={text}
                rows={2}
                disabled={sending}
                onChange={(event) => {
                  setText(event.target.value);
                  persistDraft(event.target.value);
                }}
                onKeyDown={onKeyDown}
                onKeyUp={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) keyHoldSend.finish(); }}
                onBlur={keyHoldSend.cancel}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.length) {
                    event.preventDefault();
                    void uploadFiles(files);
                  }
                }}
              />

              {generating && active ? <CancelGenerationButton conversationId={conversation!.id} generationId={active.id} className="composer-stop-button" /> : null}
              </div>

              <AttachmentList attachments={attachments} setAttachments={setAttachments} disabled={uploading || sending} />
              {attachments.some((asset) => asset.kind === "image") && !imageConfigured ? (
                <p className="composer-warning">{t("Composer.this_model_does_not_support_images_and_the_agent_has")}</p>
              ) : null}
              {quickReplies.some((reply) => reply.pinned) ? (
                <div className="quick-reply-row" aria-label={t("Composer.quick_replies")}>
                  {quickReplies.filter((reply) => reply.pinned).map((reply) => (
                    <button type="button" className="quick-reply" key={reply.id} title={reply.tooltip || reply.label} onClick={() => void useQuickReply(reply)} disabled={controlsDisabled}>
                      {reply.mode === "script" ? <Zap size={13} aria-hidden="true" /> : null}{reply.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="composer-tools" ref={toolbar.ref} data-compact={toolbar.compact || undefined}>
                <div className="composer-tool-scroll">
                  {!toolbar.foldAgent ? <AgentPicker agents={agents} value={effectiveAgentId} disabled={controlsDisabled} onChange={chooseAgent} /> : null}

                  <ModelPicker
                    effectiveModelId={effectiveModelId}
                    explicitValue={explicitModel === undefined ? INHERIT : explicitModel ?? NO_MODEL}
                    agentModelId={effectiveAgent?.execution.modelId ?? null}
                    models={models}
                    connections={connections}
                    disabled={controlsDisabled}
                    onChange={chooseModel}
                  />

                  <ReasoningPicker value={selectedReasoning} inherited={inheritedReasoning} model={effectiveModel} disabled={controlsDisabled} onChange={chooseReasoning} />

                  <Popover.Root modal={false} open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setTypographyOpen(false); }}>
                    {typographyOpen ? <Popover.Anchor virtualRef={inputAreaRef} /> : null}
                    <Popover.Trigger asChild><button type="button" className="chip composer-settings-trigger"
                      aria-label={t("Composer.more_settings")} title={t("Composer.more_settings")}>
                      <Settings2 size={26} />
                      {Object.keys(overrides).length ? <b>{Object.keys(overrides).length}</b> : null}
                    </button></Popover.Trigger>
                    <Popover.Portal><Popover.Content className="composer-more-popover composer-settings-popover" side="top" align="start" sideOffset={10}
                      onInteractOutside={(event) => { if (typographyOpen) event.preventDefault(); }}>
                      {typographyOpen ? <>
                        <div className="chat-typography-heading"><button type="button" onClick={() => setTypographyOpen(false)}>{t("Composer.back")}</button><strong>{t("SettingsView.chat_typography")}</strong>
                          <button type="button" aria-label={t("Composer.close_typography_settings")} onClick={() => { setSettingsOpen(false); setTypographyOpen(false); }}><X size={18} /></button></div>
                        <ChatTypographySettings />
                      </> : <>
                      <button type="button" onClick={() => setTypographyOpen(true)}><span><strong>{t("SettingsView.chat_typography")}</strong><small>{t("Composer.font_size_letter_spacing_and_line_height")}</small></span></button>
                      {toolbar.foldAgent ? <AgentPicker menuItem agents={agents} value={effectiveAgentId} disabled={controlsDisabled}
                        onChange={(id) => { setSettingsOpen(false); chooseAgent(id); }} /> : null}
                      <button type="button" aria-label={t("SettingsView.choose_working_directory")} onClick={() => { setSettingsOpen(false); setPickingWorkspace(true); }} disabled={controlsDisabled}>
                        <FolderOpen size={18} /><span><strong>{t("SettingsView.working_directory")}</strong><small>{workspace ?? t("Composer.not_selected")}</small></span>
                      </button>
                      <button type="button" data-execution-settings aria-label={t("Composer.advanced_execution_settings")} onClick={() => { setSettingsOpen(false); setEditingOverrides(true); }} disabled={controlsDisabled}>
                        <Settings2 size={18} /><span><strong>{t("Composer.advanced_execution_settings")}</strong><small>{Object.keys(overrides).length ? t("Composer.overrides", { count: Number((Object.keys(overrides).length)), value1: (Object.keys(overrides).length) }) : t("dialogs.follow_agent_2")}</small></span>
                      </button>
                      </>}
                    </Popover.Content></Popover.Portal>
                  </Popover.Root>

                </div>
                <div className="composer-action-group">
                  <AttachmentMenu uploadFiles={uploadFiles} disabled={offline || sending || attachments.length >= 8} uploading={uploading} />

                  <button
                    type="button"
                    className="send-button"
                    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture?.(event.pointerId); holdSend.start(true); }}
                    onPointerUp={(event) => { const box = event.currentTarget.getBoundingClientRect();
                      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) holdSend.cancel(); else holdSend.finish(); }}
                    onPointerCancel={holdSend.cancel}
                    onContextMenu={(event) => event.preventDefault()}
                    onClick={(event) => { if (event.detail === 0) void sendMessage(); }}
                    disabled={sendDisabled}
                    aria-label={active ? t("Composer.add_to_queue") : t("RoleplayTab.send")}
                    title={active ? t("Composer.click_to_queue_after_this_turn_hold_to_steer_before") : t("Composer.send_hold_to_steer_during_generation")}
                  >
                    <Send size={18} />
                  </button>
                </div>
              </div>
            </>
        </div>
        <MessageQueueList conversationId={conversation?.id} items={queuedMessages} reload={reloadQueue} paused={queuePaused} />

      </div>

      {actionsHost && conversation ? createPortal((<Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
                    <Popover.Trigger asChild>
                      <button type="button" className="icon-button" aria-label={t("Composer.conversation_actions")} title={t("Composer.more")}>
                        <MoreHorizontal size={17} aria-hidden="true" />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content className="composer-more-popover" side="bottom" align="end" sideOffset={10}>
                        {roleplayAvailable ? (
                          <button type="button" aria-label={t("RoleplayConversationDialog.roleplay_conversation_settings")} onClick={() => { setMoreOpen(false); onOpenRoleplay(); }} disabled={controlsDisabled}>
                            <Drama size={16} aria-hidden="true" />
                            <span><strong>{t("Composer.character_chat")}</strong><small>{t("Composer.presets_personas_world_books_and_scenarios")}</small></span>
                          </button>
                        ) : null}
                        {quickReplies.filter((reply) => !reply.pinned).map((reply) => (
                          <button type="button" key={reply.id} title={reply.tooltip || reply.label} onClick={() => { setMoreOpen(false); void useQuickReply(reply); }} disabled={controlsDisabled}>
                            <Zap size={16} aria-hidden="true" />
                            <span><strong>{reply.label}</strong><small>{reply.mode === "insert" ? t("RoleplayTab.insert_into_draft") : reply.mode === "send" ? t("RoleplayTab.send_immediately") : t("RoleplayTab.restricted_script")}</small></span>
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label={t("Composer.compact_context_now")}
                          onClick={() => { setMoreOpen(false); onCompact(); }}
                          disabled={controlsDisabled || compacting || !canCompact}
                          title={canCompact ? t("Composer.compact_context_now") : t("Composer.smart_or_summary_mode_can_compact_after_at_least_three")}
                        >
                          {compacting ? <LoaderCircle className="spin" size={16} /> : <Minimize2 size={16} />}
                          <span><strong>{t("Composer.compact_context")}</strong><small>{canCompact ? t("Composer.generate_conversation_summary_now") : t("Composer.currently_unavailable")}</small></span>
                        </button>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>), actionsHost) : null}

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
            await saveOverrides(next, t("Composer.execution_settings_saved"));
            setEditingOverrides(false);
          }}
        />
      ) : null}
      {pendingAgent ? (
        <AgentSwitchDialog onClose={() => setPendingAgent(null)} onConfirm={() => void applyAgent(pendingAgent)} />
      ) : null}
    </div>
  );
});

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
  item: ComposerMessageState["pendingApprovals"][number];
  count: number;
  onInspect: (target: InspectionTarget) => void;
}) {
  useLocale();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useErrorState(null);

  const resolve = async (approved: boolean) => {
    setBusy(true);
    setError("");
    try {
      const result = await endpoints.resolveToolCall(conversationId, item.call.id, approved, approved ? undefined : reason.trim() || undefined);
      await loadMessages(conversationId);
      if (result.resumed) restartGenerationTracking(conversationId, item.messageId, result.generationId);
      setDenying(false);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("Composer.approval_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="approval-card" aria-label={t("Composer.tool_approval")}>
      <header>
        <Wrench size={17} aria-hidden="true" />
        <div>
          <strong>{item.call.name}</strong>
          <span>{t("Composer.item_1_of", { value1: (count) })}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() =>
            onInspect({
              kind: "tool",
              messageId: item.messageId,
              generationId: item.generationId,
              toolCallId: item.call.id
            })
          }
          aria-label={t("MessageStream.inspect_tool_call")}
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
          <span>{t("Composer.reason_for_rejection_optional")}</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
        </label>
      ) : null}
      <footer>
        {denying ? (
          <>
            <Button onClick={() => setDenying(false)} disabled={busy}>{t("Composer.back")}</Button>
            <Button variant="danger" onClick={() => void resolve(false)} disabled={busy}>{t("Composer.confirm_rejection")}</Button>
          </>
        ) : (
          <>
            <Button onClick={() => setDenying(true)} disabled={busy}>{t("Composer.reject")}</Button>
            <Button variant="primary" onClick={() => void resolve(true)} disabled={busy}>{t("Composer.allow")}</Button>
          </>
        )}
      </footer>
    </section>
  );
}
