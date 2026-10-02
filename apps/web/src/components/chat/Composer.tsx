import { readSubmission, saveSubmission, submissionStore, waitForSubmission, type Submission, type SubmissionActions } from "../../lib/submission";
import { PopoverLayer, Presence } from "../../lib/motion";
import { effectiveReasoningSelection, legacyReasoningSelection, type ReasoningSelection } from "@llm-chat/contracts";
import { errorDisplayMessage, useErrorState } from "../../lib/error-display";
import { t, useLocale, localized } from "../../lib/i18n";
import { offlineStore } from "../../lib/offline-history";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
  SubmissionAcceptedDto,
} from "@llm-chat/contracts";
import { recoveredDraftIds, swapRecoveredDraft, readComposerDraft, writeComposerDraft, scheduleServerDraft, flushServerDraft, serializeModelSelection } from "../../lib/composer-drafts";
import { ApiRequestError, endpoints } from "../../lib/api";
import { acceptSubmission, appStore, isGenerationActive, loadMessages, refreshAgents, refreshConversations, restartGenerationTracking, submitConversation, toast, toastError, trackGeneration, updateConversationImmediately } from "../../lib/app-state";
import type { InspectionTarget } from "../../lib/inspection";
import { captureNavigation, navigateIfCurrent, ownsNavigation, routes } from "../../lib/router";
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
import { requestBudget } from "../../lib/http-client";


/**
 * The composer owns everything about the *next* turn: what to say, which Agent
 * and model answer it, per-conversation overrides, image attachments, and the
 * approval gate and messages queued for subsequent turns.
 */
export const Composer = memo(function Composer({
  actionsHost = null,
  mobile = false,
  conversation,
  conversationId = conversation?.id ?? null,
  submissionActions,
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
  conversationId?: string | null;
  submissionActions?: RefObject<SubmissionActions | null>;
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

  const [initialDraft] = useState(() => readComposerDraft(conversationId));
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typographyOpen, setTypographyOpen] = useState(false);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const submissionController = useRef<AbortController | null>(null);
  const inFlightSubmission = useRef<Submission | null>(null);
  const selectionRevision = useRef(0);
  const [attachmentSeed, setAttachmentSeed] = useState(initialDraft?.attachments ?? []);
  const [newDraftScope, setNewDraftScope] = useState(() => initialDraft?.uploadScopeId ?? `draft:${crypto.randomUUID()}`);
  const { attachments, setAttachments, uploading, uploadFiles, uploadScope, attachmentCount } = useAttachments(
    attachmentSeed, conversation ? `conversation:${conversation.id}` : newDraftScope, conversation?.id);
  const { items: queuedMessages, paused: queuePaused, reload: reloadQueue } = useMessageQueue(conversation?.id);
  const liveInput = useRef({ text, attachments });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  liveInput.current = { text, attachments };
  const wasGenerating = useRef(false);
  const currentDraft = useRef("");
  const isNew = !conversationId;

  const effectiveAgentId = conversation?.agentId ?? newAgentId ?? fallbackAgent?.id ?? "";
  const effectiveAgent = agents.find((agent) => agent.id === effectiveAgentId);
  useEffect(() => {
    if (conversation || text || attachments.length || explicitNewModel.current) return;
    setNewOverrides((current) => {
      const inherited = { ...current };
      delete inherited.modelId;
      const next = initialOverrides(effectiveAgentId, inherited);
      return next.modelId === current.modelId && Object.hasOwn(next, "modelId") === Object.hasOwn(current, "modelId")
        ? current : next;
    });
  }, [conversation?.id, effectiveAgentId, agents, models, connections, text, attachments.length]);
  const persistLocalDraft = (draftText: string, draftAttachments: typeof attachments) => {
    const savedOverrides = { ...(conversation?.executionOverrides ?? newOverrides) };
    if (!draftText && !draftAttachments.length && !explicitNewModel.current) delete savedOverrides.modelId;
    writeComposerDraft(conversationId, {
      uploadScopeId: uploadScope, text: draftText, attachments: draftAttachments, agentId: effectiveAgentId || null, overrides: savedOverrides,
      workspace: conversation ? conversation.workspacePath : newWorkspace, greetingIndex
    });
  };
  useLayoutEffect(() => {
    persistLocalDraft(text, attachments);
  }, [conversation?.id, text, attachments, effectiveAgentId, newOverrides, newWorkspace, greetingIndex, uploadScope]);
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

  const generating = Boolean(active && active.status !== "waiting-approval");
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
    const revision = ++selectionRevision.current;
    if (!conversation) {
      if (explicitSelection || next.modelId !== overrides.modelId) explicitNewModel.current = Object.hasOwn(next, "modelId");
      setNewOverrides(initialOverrides(effectiveAgentId, next));
    }
    const remember = typeof next.modelId === "string" && (explicitSelection || next.modelId !== overrides.modelId);
    try {
      if (conversation) {
        await updateConversationImmediately(conversation.id, explicitSelection && typeof next.modelId === "string"
          ? { modelId: next.modelId } : { executionOverrides: next });
        void refreshConversations().catch(() => {});
      } else if (remember) await serializeModelSelection(effectiveAgentId, () => endpoints.selectAgentModel(effectiveAgentId, next.modelId!));
      if (remember) void refreshAgents().catch(() => {});
      if (message) toast("success", message);
    } catch (error) {
      if (mounted.current && revision === selectionRevision.current) toastError(error);
      throw error;
    }
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
      setPendingAgent(null);
      await updateConversationImmediately(conversation.id, { agentId });
      void refreshConversations().catch(toastError);
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
      await updateConversationImmediately(conversation.id, { workspacePath: path });
      void refreshConversations().catch(toastError);
      toast("success", path ? t("Composer.working_directory_updated") : t("Composer.working_directory_cleared"));
    } catch (error) {
      toastError(error);
    }
  };

  const recovery = useRef<(receipt: SubmissionAcceptedDto) => void>(() => {});
  const stopAcceptedSubmission = (attempt: Submission, receipt: SubmissionAcceptedDto) => {
    if (!attempt.cancelRequested) return;
    const id = receipt.conversation.id;
    const stop = receipt.kind === "queue"
      ? receipt.result.generationId ? endpoints.cancelGeneration(id, receipt.result.generationId) : endpoints.deleteQueuedMessage(id, receipt.result.id)
      : endpoints.cancelGeneration(id, receipt.kind === "start" ? receipt.result.generation.generationId : receipt.result.generationId);
    void stop.catch(toastError);
  };
  recovery.current = receipt => {
    const id = conversationId;
    const attempt = readSubmission(id);
    if (!attempt || attempt.id !== receipt.clientSubmissionId || sendingRef.current || appStore.get().auth !== "ready" || appStore.get().sourceId !== receipt.sourceId) return;
    saveSubmission(id, null);
    acceptSubmission(receipt);
    stopAcceptedSubmission(attempt, receipt);
    if (!ownsNavigation(attempt.navigation)) {
      void Promise.all([loadMessages(receipt.conversation.id), refreshConversations()]).catch(toastError);
      return;
    }
    if (receipt.kind === "start") {
      const draft = { uploadScopeId: uploadScope, ...liveInput.current, agentId: attempt.input.agentId,
        overrides: {}, workspace: attempt.input.workspacePath, greetingIndex: 0 };
      writeComposerDraft(receipt.conversation.id, draft);
      writeComposerDraft(null, { ...draft, uploadScopeId: `draft:${crypto.randomUUID()}`, text: "", attachments: [] });
      navigateIfCurrent(routes.chat(receipt.conversation.id), attempt.navigation!);
    }
    void Promise.all([loadMessages(receipt.conversation.id), refreshConversations(), ...(receipt.kind === "queue" ? [reloadQueue()] : [])]).catch(toastError);
  };
  useEffect(() => {
    const id = conversationId;
    let alive = true;
    const reconcile = () => {
      const attempt = readSubmission(id);
      if (!attempt) return;
      const known = submissionStore.get().accepted[attempt.id];
      if (known) { recovery.current(known); return; }
      void endpoints.submission(attempt.id, id, attempt.kind).then(receipt => {
        if (!alive || appStore.get().auth !== "ready" || appStore.get().sourceId !== receipt.sourceId || readSubmission(id)?.id !== receipt.clientSubmissionId) return;
        acceptSubmission(receipt); recovery.current(receipt);
      }).catch(() => {});
    };
    const previous = readSubmission(id);
    if (previous) {
      const owner = captureNavigation();
      if (!previous.navigation || previous.navigation.session !== owner.session) previous.navigation = owner;
      previous.status = "unknown"; saveSubmission(id, previous); reconcile();
    }
    const unsubscribe = submissionStore.subscribe(() => {
      const attempt = readSubmission(id);
      const receipt = attempt && submissionStore.get().accepted[attempt.id];
      if (receipt) recovery.current(receipt);
    });
    window.addEventListener("llm-chat:queue-reconnect", reconcile);
    window.addEventListener("llm-chat:offline-reconnected", reconcile);
    return () => { alive = false; unsubscribe(); window.removeEventListener("llm-chat:queue-reconnect", reconcile); window.removeEventListener("llm-chat:offline-reconnected", reconcile); };
  }, [conversationId]);

  const sendMessage = async (overrideText?: string, steer = false, retry?: Submission) => {
    const originalText = overrideText ?? text;
    if (sendingRef.current || (conversationId && !conversation) || (!retry && ((!originalText.trim() && !attachments.length) || uploading))) return;
    if (!retry && (!effectiveAgent || !modelAvailable)) {
      toast("error", localized(!effectiveAgent ? "Composer.select_an_agent_first" : "Composer.select_an_available_model_first"));
      return;
    }
    if (!retry && attachments.some(asset => asset.kind === "image") && !imageConfigured) {
      toast("error", localized("Composer.this_model_does_not_support_images_configure_a_fallback_vision")); return;
    }
    const id = conversation?.id ?? null;
    const submittedRoute = location.pathname;
    const navigation = captureNavigation();
    const sourceAtSend = appStore.get().sourceId;
    const validSession = () => appStore.get().auth !== "required" && appStore.get().sourceId === sourceAtSend;
    const syncAfterSend = (reads: Promise<unknown>[]) => {
      void Promise.all(reads).catch(() => toast("error", localized("Composer.sync_failed_after_send")));
    };
    const previous = readSubmission(id);
    const reusable = previous && previous.originalText === originalText && JSON.stringify(previous.assetIds) === JSON.stringify(attachments.map(asset => asset.id))
      && previous.mode === (steer ? "steer" : "queue") && previous.input.agentId === effectiveAgent?.id
      && (id !== null || JSON.stringify(previous.input) === JSON.stringify({ agentId: effectiveAgent?.id, greetingIndex, executionOverrides: newOverrides, workspacePath: newWorkspace }));
    const attempt: Submission = retry ?? (reusable ? previous : null) ?? {
      id: crypto.randomUUID(), kind: !conversation ? "start" : active || (!queuePaused && queuedMessages.some(item => item.status !== "failed")) ? "queue" : "send",
      originalText, text: originalText.trim(), assetIds: attachments.map(asset => asset.id), attachments: [...attachments], mode: steer ? "steer" : "queue",
      input: { agentId: effectiveAgent!.id, greetingIndex, executionOverrides: newOverrides, workspacePath: newWorkspace }, prepared: false, createdAt: Date.now()
    };
    // Persist before attempting I/O. This is a manual retry receipt, not an outbox.
    sendingRef.current = true; setSending(true);
    delete attempt.error; delete attempt.cancelRequested;
    attempt.route = submittedRoute; attempt.navigation = navigation; attempt.status = "preparing"; saveSubmission(id, attempt);
    if (!retry) {
      const live = liveInput.current;
      const draftText = overrideText === undefined || live.text === originalText ? "" : live.text;
      const draftAttachments = live.attachments.filter(asset => !attempt.assetIds.includes(asset.id));
      // Confirmation can arrive before React commits these state updates.
      liveInput.current = { text: draftText, attachments: draftAttachments };
      setText(draftText); setAttachments(draftAttachments);
      persistLocalDraft(draftText, draftAttachments);
      persistDraft(draftText);
    }
    onBeforeSend();
    const controller = new AbortController(); submissionController.current = controller;
    inFlightSubmission.current = attempt;
    const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(requestBudget("POST"))]);
    let accepted = false;
    const finishSubmission = () => {
      accepted = true;
      const ownsInput = mounted.current && ownsNavigation(navigation) && readSubmission(id)?.id === attempt.id;
      if (readSubmission(id)?.id === attempt.id) saveSubmission(id, null);
      offlineStore.set({ offline: false });
      return ownsInput;
    };
    const execute = async () => {
      if (!attempt.prepared && conversation && roleplayAgent && roleplayState && quickReplies.some(reply => reply.mode === "script" && reply.autoTriggers.includes("before_send"))) {
        const automated = await endpoints.executeRoleplayScript(conversation.id, { trigger: "before_send", draft: attempt.originalText.trim(), clientSubmissionId: attempt.id }, deadline);
        onRoleplayStateChange(automated.state);
        attempt.text = (automated.sendText ?? automated.draft ?? attempt.text).trim();
      }
      attempt.prepared = true; attempt.status = "submitting";
      if (readSubmission(id)?.id === attempt.id) saveSubmission(id, attempt);
      if (!attempt.text && !attempt.assetIds.length) throw new Error(t("Composer.the_before_send_script_cleared_the_message"));
      if (attempt.kind === "start") {
        const result = await waitForSubmission(attempt.id, signal => endpoints.startConversation({ ...attempt.input, text: attempt.text, assetIds: attempt.assetIds, clientSubmissionId: attempt.id }, AbortSignal.any([deadline, signal])));
        if (!validSession()) return;
        if (result.acceptance) acceptSubmission(result.acceptance);
        const ownsInput = finishSubmission();
        // Preserve text typed during submission when navigation mounts the new composer.
        const nextDraft = { uploadScopeId: uploadScope, ...liveInput.current, agentId: attempt.input.agentId,
          overrides: {}, workspace: attempt.input.workspacePath, greetingIndex: 0 };
        if (ownsInput) {
          writeComposerDraft(result.conversation.id, nextDraft);
          writeComposerDraft(null, { ...nextDraft, uploadScopeId: `draft:${crypto.randomUUID()}`, text: "", attachments: [] });
        }
        appStore.set(state => ({ settings: ownsInput && state.settings ? { ...state.settings, lastAgentId: attempt.input.agentId } : state.settings,
          conversations: state.conversations.some(item => item.id === result.conversation.id) ? state.conversations : [result.conversation, ...state.conversations] }));
        trackGeneration(result.conversation.id, result.generation.assistantMessageId, result.generation.generationId);
        if (attempt.cancelRequested) void endpoints.cancelGeneration(result.conversation.id, result.generation.generationId).catch(toastError);
        if (ownsInput) navigateIfCurrent(routes.chat(result.conversation.id), navigation);
        if (effectiveAgent?.roleplayEnabled) void endpoints.executeRoleplayScript(result.conversation.id, { trigger: "new_chat", draft: "", clientSubmissionId: attempt.id }).catch(() => {});
        syncAfterSend([refreshConversations(), loadMessages(result.conversation.id)]);
      } else {
        if (attempt.kind === "send") {
          try {
            const result = await waitForSubmission(attempt.id, signal => endpoints.sendMessage(id!, attempt.text, attempt.assetIds, attempt.id, AbortSignal.any([deadline, signal])));
            if (!validSession()) return;
            if (result.acceptance) acceptSubmission(result.acceptance);
            finishSubmission();
            trackGeneration(id!, result.assistantMessageId, result.generationId);
            if (attempt.cancelRequested) void endpoints.cancelGeneration(id!, result.generationId).catch(toastError);
          } catch (error) {
            if (accepted || !(error instanceof ApiRequestError) || error.code !== "conversation_busy") throw error;
            attempt.kind = "queue";
            if (readSubmission(id)?.id === attempt.id) saveSubmission(id, attempt);
          }
        }
        if (attempt.kind === "queue") {
          const result = await waitForSubmission(attempt.id, signal => endpoints.enqueueMessage(id!, attempt.text, attempt.assetIds, attempt.mode, attempt.id, AbortSignal.any([deadline, signal])));
          if (!validSession()) return;
          if (result.acceptance) acceptSubmission(result.acceptance);
          finishSubmission();
          if (attempt.cancelRequested) void (result.generationId ? endpoints.cancelGeneration(id!, result.generationId) : endpoints.deleteQueuedMessage(id!, result.id)).catch(toastError);
          syncAfterSend([reloadQueue()]);
        }
        syncAfterSend([loadMessages(id!), refreshConversations()]);
      }
    };
    try {
      if (conversation) await submitConversation(conversation.id, execute);
      else await execute();
    } catch (error) {
      if (!validSession()) return;
      if (accepted) toast("error", localized("Composer.sync_failed_after_send"));
      else if (readSubmission(id)?.id === attempt.id) {
        attempt.status = "unknown"; attempt.error = errorDisplayMessage(error); saveSubmission(id, attempt);
        void endpoints.submission(attempt.id, id, attempt.kind).then(receipt => { if (validSession()) { acceptSubmission(receipt); recovery.current(receipt); } }).catch(() => {});
      }
    } finally {
      sendingRef.current = false;
      if (submissionController.current === controller) submissionController.current = null;
      if (inFlightSubmission.current === attempt) inFlightSubmission.current = null;
      setSending(false);
      const receipt = submissionStore.get().accepted[attempt.id];
      if (receipt && validSession()) recovery.current(receipt);
    }
  };

  useLayoutEffect(() => {
    if (!submissionActions) return;
    const actions: SubmissionActions = {
      retry: value => { void sendMessage(undefined, false, value); },
      edit: value => {
        const draftAttachments = value.attachments ?? [];
        liveInput.current = { text: value.originalText, attachments: draftAttachments };
        setText(value.originalText); setAttachments(draftAttachments);
        persistLocalDraft(value.originalText, draftAttachments);
        persistDraft(value.originalText);
      },
      cancel: value => {
        if (inFlightSubmission.current?.id === value.id) inFlightSubmission.current.cancelRequested = true;
        value.cancelRequested = true;
        saveSubmission(conversationId, value);
        submissionController.current?.abort();
      }
    };
    submissionActions.current = actions;
    return () => { if (submissionActions.current === actions) submissionActions.current = null; };
  });

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
      toast("info", localized("Composer.create_a_conversation_before_running_sandboxed_scripts")); return;
    }
    try {
      const result = await endpoints.executeRoleplayScript(conversation.id, { quickReplyId: reply.id, draft: text });
      liveInput.current = { ...liveInput.current, text: result.draft };
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

  const controlsDisabled = false;
  const sendDisabled = sending || Boolean(conversationId && !conversation) ||
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
          setText(draft.text); setAttachmentSeed(draft.attachments); setNewDraftScope(draft.uploadScopeId ?? `draft:${crypto.randomUUID()}`); setNewAgentId(draft.agentId);
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

              <AttachmentList uploadScope={uploadScope} attachments={attachments} setAttachments={setAttachments} disabled={false} />
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

                  <Popover.Root modal={false} open={settingsOpen} onOpenChange={(open) => { if (open) setTypographyOpen(false); setSettingsOpen(open); }}>
                    {typographyOpen ? <Popover.Anchor virtualRef={inputAreaRef} /> : null}
                    <Popover.Trigger asChild><button type="button" className="chip composer-settings-trigger"
                      aria-label={t("Composer.more_settings")} title={t("Composer.more_settings")}>
                      <Settings2 size={26} />
                      {Object.keys(overrides).length ? <b>{Object.keys(overrides).length}</b> : null}
                    </button></Popover.Trigger>
                    <Popover.Portal><Popover.Content className="composer-more-popover composer-settings-popover" side="top" align="start" sideOffset={10}
                      inert={!settingsOpen ? true : undefined} aria-hidden={!settingsOpen || undefined}
                      onInteractOutside={(event) => { if (typographyOpen) event.preventDefault(); }}><PopoverLayer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
                      {typographyOpen ? <>
                        <div className="chat-typography-heading"><button type="button" onClick={() => setTypographyOpen(false)}>{t("Composer.back")}</button><strong>{t("SettingsView.chat_typography")}</strong>
                          <button type="button" aria-label={t("Composer.close_typography_settings")} onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
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
                  <AttachmentMenu uploadFiles={uploadFiles} disabled={attachmentCount >= 8} uploading={uploading} />

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
                      <Popover.Content className="composer-more-popover" side="bottom" align="end" sideOffset={10} inert={!moreOpen ? true : undefined} aria-hidden={!moreOpen || undefined}><PopoverLayer open={moreOpen} onClose={() => setMoreOpen(false)} />
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
                          disabled={generating || sending || compacting || !canCompact}
                          title={canCompact ? t("Composer.compact_context_now") : t("Composer.smart_or_summary_mode_can_compact_after_at_least_three")}
                        >
                          {compacting ? <LoaderCircle className="spin" size={16} /> : <Minimize2 size={16} />}
                          <span><strong>{t("Composer.compact_context")}</strong><small>{canCompact ? t("Composer.generate_conversation_summary_now") : t("Composer.currently_unavailable")}</small></span>
                        </button>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>), actionsHost) : null}

      <Presence>{pickingWorkspace ? (
        <DirectoryPicker
          initialPath={workspace}
          onClose={() => setPickingWorkspace(false)}
          onSelect={(path) => void chooseWorkspace(path)}
        />
      ) : null}</Presence>
      <Presence>{editingOverrides ? (
        <ExecutionOverridesDialog
          {...(conversation ? { conversationId: conversation.id } : {})}
          value={overrides}
          agent={effectiveAgent}
          models={models}
          onClose={() => setEditingOverrides(false)}
          onSave={async (next) => {
            await saveOverrides(next, t("Composer.execution_settings_saved"));
            setEditingOverrides(false);
          }}
        />
      ) : null}</Presence>
      <Presence>{pendingAgent ? (
        <AgentSwitchDialog onClose={() => setPendingAgent(null)} onConfirm={() => void applyAgent(pendingAgent)} />
      ) : null}</Presence>
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
      void loadMessages(conversationId).catch(toastError);
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
