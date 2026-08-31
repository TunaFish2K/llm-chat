import type {
  AgentSummaryDto,
  AppSettings,
  BackgroundTaskDto,
  ConnectionDto,
  ContextPolicy,
  ConversationDto,
  ConversationExecutionOverrides,
  GenerationDto,
  MessageDto,
  ModelDto,
  ReasoningEffort,
  ToolCallDto,
  ToolCatalogItemDto
} from "@llm-chat/contracts";
import {
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  ControlOutlined,
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  RightOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined
} from "@ant-design/icons";
import { Actions, Bubble, Conversations, Sender, Think, Welcome, type BubbleItemType } from "@ant-design/x";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Breadcrumb,
  Checkbox,
  Collapse,
  Drawer,
  Dropdown,
  Flex,
  Grid,
  Input,
  InputNumber,
  Layout,
  Listy,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography
} from "antd";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, appEvents, generationEvents } from "./api";
import { ModelSelector, isModelUsable, protocolShortName } from "./ModelSelector";
import { ReasoningEffortControl } from "./ReasoningEffortControl";
import { applyGenerationEvent, blockText, streamEnded } from "./generationState";
import { AppTheme, resolveColorScheme, type ColorScheme } from "./theme";
import {
  initialReasoningExpanded,
  defaultUiPreferences,
  type ReasoningCollapsePolicy,
  type UiPreferences
} from "./uiPreferences";

const { Content, Header, Sider } = Layout;
const { Text } = Typography;

const Markdown = lazy(() => import("./Markdown").then((module) => ({ default: module.Markdown })));
const SettingsPanel = lazy(() => import("./SettingsPanel").then((module) => ({ default: module.SettingsPanel })));
const TaskTerminal = lazy(() => import("./TaskTerminal").then((module) => ({ default: module.TaskTerminal })));

interface BootData {
  settings: AppSettings;
  agents: AgentSummaryDto[];
  connections: ConnectionDto[];
  models: ModelDto[];
  conversations: ConversationDto[];
}

const CONTEXT_POLICIES: Array<{ label: string; value: ContextPolicy }> = [
  { label: "裁剪", value: "trim" },
  { label: "摘要", value: "summarize" },
  { label: "完整", value: "full" }
];

const REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export function App() {
  const [boot, setBoot] = useState<BootData | null>(null);
  const [currentId, setCurrentId] = useState(() => conversationFromPath());
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [newOverrides, setNewOverrides] = useState<ConversationExecutionOverrides>({});
  const [newWorkspacePath, setNewWorkspacePath] = useState<string | null>(null);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [liveGenerationId, setLiveGenerationId] = useState<string | null>(null);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<BackgroundTaskDto[]>([]);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationDto | null>(null);
  const [error, setError] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const draftReady = useRef(false);
  const screens = Grid.useBreakpoint();
  const compactSidebar = !screens.lg;
  const mobileLayout = !screens.md;

  const refreshBoot = useCallback(async () => {
    const [settings, agents, connections, models, conversations] = await Promise.all([
      api.settings(), api.agents(), api.connections(), api.models(), api.conversations()
    ]);
    setBoot({ settings, agents, connections, models, conversations });
  }, []);

  useEffect(() => { void refreshBoot().catch((value) => setError(messageOf(value))); }, [refreshBoot]);
  useEffect(() => {
    if (!boot || currentId || newWorkspacePath !== null || !boot.settings.lastWorkspacePath) return;
    setNewWorkspacePath(boot.settings.lastWorkspacePath);
  }, [boot, currentId, newWorkspacePath]);
  const refreshTasks = useCallback(async () => setTasks(await api.backgroundTasks(undefined, true)), []);
  useEffect(() => {
    void refreshTasks().catch(() => {});
    return appEvents((event) => {
      if (event.type === "task") {
        setTasks((current) => current.some((task) => task.id === event.task.id)
          ? replace(current, event.task)
          : [event.task, ...current]);
      } else if (event.type === "task-output") {
        setTasks((current) => current.map((task) => task.id === event.taskId ? { ...task, outputCursor: event.cursor } : task));
      }
      if ((event.type === "plugin" || event.type === "skill") && (event.state === "pending-reload" || event.state === "error")) {
        setError(event.message ?? `${event.type === "plugin" ? "Plugin" : "Skill"} 状态已变化，请到扩展设置处理`);
      }
    });
  }, [refreshTasks]);
  useEffect(() => {
    const handler = () => setCurrentId(conversationFromPath());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const current = boot?.conversations.find((item) => item.id === currentId) ?? null;
  const fallbackAgentId = boot?.agents.some((agent) => agent.id === boot.settings.lastAgentId)
    ? boot.settings.lastAgentId
    : boot?.settings.defaultAgentId ?? null;
  const selectedAgentId = current ? current.agentId : newAgentId ?? fallbackAgentId;
  const selectedAgent = boot?.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const activeOverrides = current?.executionOverrides ?? newOverrides;
  const enabledModels = useMemo(() => boot?.models.filter((model) => model.enabled) ?? [], [boot?.models]);
  const selectedModelId = current?.modelId ?? (Object.hasOwn(activeOverrides, "modelId")
    ? activeOverrides.modelId ?? null
    : selectedAgent?.execution.modelId ?? null);
  const selectedModel = boot?.models.find((item) => item.id === selectedModelId) ?? null;
  const selectedModelAvailable = isModelUsable(selectedModel, boot?.connections ?? []);
  const selectedContextPolicy = activeOverrides.contextPolicy ?? selectedAgent?.execution.contextPolicy ?? "trim";
  const selectedReasoningEffort = activeOverrides.reasoningEffort ?? selectedAgent?.execution.reasoningEffort ?? "none";
  const uiPreferences = boot?.settings.uiPreferences ?? defaultUiPreferences;
  const activeApprovalGeneration = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.generations.find((generation) => generation.id === message.activeGenerationId))
    .find((generation) => generation?.toolCalls.some((toolCall) => toolCall.approvalState === "pending"));
  const pendingApprovals = activeApprovalGeneration?.toolCalls
    .filter((toolCall) => toolCall.approvalState === "pending")
    .sort((left, right) => left.index - right.index) ?? [];
  const waitingToolApproval = pendingApprovals.length > 0;

  const loadMessages = useCallback(async (conversationId: string) => {
    const data = await api.messages(conversationId);
    setMessages(data);
    const active = data.flatMap((message) => message.generations)
      .find((generation) => generation.status === "queued" || generation.status === "running");
    setLiveGenerationId(active?.id ?? null);
  }, []);

  useEffect(() => {
    draftReady.current = false;
    setMessages([]);
    setDraft(current?.draft ?? "");
    setTitleEditing(false);
    setTitleDraft(current?.title ?? "");
    queueMicrotask(() => { draftReady.current = true; });
    if (currentId) void loadMessages(currentId).catch((value) => setError(messageOf(value)));
  }, [currentId, current?.id, loadMessages]);

  useEffect(() => {
    if (!currentId || !draftReady.current) return;
    const timer = setTimeout(() => {
      void api.updateConversation(currentId, { draft }).then((updated) => {
        setBoot((value) => value ? { ...value, conversations: replace(value.conversations, updated) } : value);
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, currentId]);

  useEffect(() => {
    if (!liveGenerationId) return;
    return generationEvents(liveGenerationId, (event) => {
      setMessages((value) => applyGenerationEvent(value, event));
      const ended = (event.type === "status" && streamEnded(event.status))
        || (event.type === "snapshot" && streamEnded(event.generation.status));
      if (ended) {
        setLiveGenerationId(null);
        if (currentId) void loadMessages(currentId);
        void refreshBoot();
      }
    });
  }, [liveGenerationId, currentId, loadMessages, refreshBoot]);

  const navigate = (id: string | null, replaceHistory = false) => {
    window.history[replaceHistory ? "replaceState" : "pushState"]({}, "", id ? `/c/${id}` : "/");
    setCurrentId(id);
    setSidebarDrawerOpen(false);
  };

  const beginConversation = () => {
    setDraft("");
    setNewAgentId(null);
    setNewOverrides({});
    setNewWorkspacePath(boot?.settings.lastWorkspacePath ?? null);
    setGreetingIndex(0);
    setError("");
    navigate(null);
  };

  const patchConversation = useCallback(async (conversation: ConversationDto, patch: Parameters<typeof api.updateConversation>[1]) => {
    try {
      const updated = await api.updateConversation(conversation.id, patch);
      setBoot((value) => value ? { ...value, conversations: replace(value.conversations, updated) } : value);
      return updated;
    } catch (value) {
      setError(messageOf(value));
      return undefined;
    }
  }, []);

  const updateUiPreferences = (next: UiPreferences) => {
    if (!boot) return;
    const previous = boot.settings.uiPreferences;
    setBoot({ ...boot, settings: { ...boot.settings, uiPreferences: next } });
    void api.updateSettings({ uiPreferences: next }).then((settings) => {
      setBoot((value) => value ? { ...value, settings } : value);
    }).catch((value) => {
      setBoot((currentBoot) => currentBoot ? {
        ...currentBoot,
        settings: { ...currentBoot.settings, uiPreferences: previous }
      } : currentBoot);
      setError(messageOf(value));
    });
  };

  const chooseModel = (modelId: string) => {
    if (!boot) return;
    if (!current) {
      setNewOverrides((value) => ({ ...value, modelId }));
      return;
    }
    void patchConversation(current, { executionOverrides: { ...current.executionOverrides, modelId } });
  };

  const chooseReasoningEffort = (reasoningEffort: ReasoningEffort) => {
    if (!current) {
      setNewOverrides((value) => ({ ...value, reasoningEffort }));
      return;
    }
    void patchConversation(current, {
      executionOverrides: { ...current.executionOverrides, reasoningEffort }
    });
  };

  const chooseContextPolicy = (contextPolicy: ContextPolicy) => {
    if (!current) {
      setNewOverrides((value) => ({ ...value, contextPolicy }));
      return;
    }
    void patchConversation(current, {
      executionOverrides: { ...current.executionOverrides, contextPolicy }
    });
  };

  const chooseAgent = (agentId: string) => {
    if (!current) {
      setNewAgentId(agentId);
      setNewOverrides({});
      setGreetingIndex(0);
      return;
    }
    const apply = () => void patchConversation(current, { agentId }).then(() => void refreshBoot());
    if (messages.length) {
      Modal.confirm({
        title: "切换 Agent？",
        content: "历史消息会保留，后续回复使用新 Agent。当前会话的模型、上下文、推理和工具覆盖项将全部清除。",
        okText: "切换",
        cancelText: "取消",
        onOk: apply
      });
    } else apply();
  };

  const openSettings = () => {
    setSidebarDrawerOpen(false);
    setSettingsOpen(true);
  };

  const send = async (text = draft) => {
    if (!boot || !selectedAgent || !selectedModelAvailable || !selectedModel || !text.trim() || liveGenerationId || waitingToolApproval) return;
    setError("");
    try {
      const content = text.trim();
      setDraft("");
      if (!currentId) {
        const started = await api.startConversation({
          text: content,
          agentId: selectedAgent!.id,
          greetingIndex,
          executionOverrides: newOverrides,
          workspacePath: newWorkspacePath
        });
        setBoot((value) => value ? { ...value, conversations: [started.conversation, ...value.conversations] } : value);
        setNewAgentId(null);
        setNewOverrides({});
        navigate(started.conversation.id, true);
        await loadMessages(started.conversation.id);
        setLiveGenerationId(started.generation.generationId);
        return;
      }
      const created = await api.send(currentId, { text: content });
      await loadMessages(currentId);
      setLiveGenerationId(created.generationId);
      await refreshBoot();
    } catch (value) {
      setDraft((currentDraft) => currentDraft || text);
      setError(messageOf(value));
    }
  };

  const respondToToolApproval = async (toolCall: ToolCallDto, approved: boolean) => {
    if (!currentId || approvalActionId) return;
    setError("");
    setApprovalActionId(toolCall.id);
    try {
      const result = await api.approveTool(toolCall.id, approved);
      await loadMessages(currentId);
      setMessages((value) => value.map((message) => ({
        ...message,
        generations: message.generations.map((generation) => ({
          ...generation,
          toolCalls: generation.toolCalls.map((item) => item.id === result.toolCall.id ? result.toolCall : item)
        }))
      })));
      if (result.resumed) setLiveGenerationId(result.generationId);
    } catch (value) {
      setError(messageOf(value));
    } finally {
      setApprovalActionId(null);
    }
  };

  const retry = async (messageId: string) => {
    if (liveGenerationId || waitingToolApproval) return;
    try {
      const created = await api.retry(messageId);
      if (currentId) await loadMessages(currentId);
      setLiveGenerationId(created.generationId);
    } catch (value) {
      setError(messageOf(value));
    }
  };

  const commitTitle = async () => {
    if (!current) return;
    const title = titleDraft.trim();
    if (!title) {
      setTitleDraft(current.title);
      setTitleEditing(false);
      return;
    }
    const updated = await patchConversation(current, { title });
    setTitleDraft(updated?.title ?? current.title);
    setTitleEditing(false);
  };

  const colorScheme = resolveColorScheme(boot?.settings.theme ?? "system", systemDark);
  if (!boot) return <AppTheme colorScheme={colorScheme}>
    <Flex className="app-loading" align="center" justify="center" gap="small"><Spin />正在启动 llm-chat</Flex>
  </AppTheme>;

  const modelSelector = <ModelSelector
    value={selectedModelId}
    models={boot.models}
    connections={boot.connections}
    onChange={chooseModel}
    onGoSettings={openSettings}
  />;
  const effortControl = <ReasoningEffortControl
    value={selectedReasoningEffort}
    mobile={compactSidebar}
    saving={false}
    onChange={chooseReasoningEffort}
  />;
  const welcomeModelSelector = <ModelSelector
    value={selectedModelId}
    models={boot.models}
    connections={boot.connections}
    onChange={chooseModel}
    onGoSettings={openSettings}
    placement={mobileLayout ? "topLeft" : "bottomLeft"}
  />;
  const welcomeEffortControl = <ReasoningEffortControl
    value={selectedReasoningEffort}
    mobile={compactSidebar}
    saving={false}
    onChange={chooseReasoningEffort}
    placement={mobileLayout ? "topLeft" : "bottomLeft"}
  />;
  const agentSelector = <AgentSelector
    value={selectedAgentId}
    agents={boot.agents}
    onChange={chooseAgent}
  />;
  const contextSelector = <Select
    className="context-selector"
    value={selectedContextPolicy}
    options={CONTEXT_POLICIES}
    onChange={chooseContextPolicy}
  />;
  const mobileExecutionControl = <MobileExecutionControl
    reasoningEffort={selectedReasoningEffort}
    contextPolicy={selectedContextPolicy}
    onReasoningEffort={chooseReasoningEffort}
    onContextPolicy={chooseContextPolicy}
  />;
  const workspaceControl = <Tooltip title={current?.workspacePath ?? newWorkspacePath ?? "选择工作目录"}>
    <Button type="text" size="small" className="workspace-trigger" icon={<FolderOpenOutlined />} aria-label="选择工作目录" onClick={() => setWorkspaceOpen(true)} />
  </Tooltip>;
  const desktopComposerToolbar = <Flex className="composer-toolbar" align="center" gap={4} wrap>
    {agentSelector}
    {modelSelector}
    {effortControl}
    {contextSelector}
    {workspaceControl}
  </Flex>;
  const mobileComposerToolbar = <MobileComposerToolbar
    agentSelector={agentSelector}
    modelSelector={modelSelector}
    executionControl={mobileExecutionControl}
    workspaceControl={workspaceControl}
  />;
  const sidebar = <SidebarContent
    conversations={boot.conversations}
    currentId={currentId}
    showBrand={!compactSidebar}
    showCollapse={!compactSidebar}
    onCollapse={() => updateUiPreferences({ ...uiPreferences, sidebarCollapsed: true })}
    onCreate={beginConversation}
    onNavigate={navigate}
    onDelete={setDeleteTarget}
    onSettings={openSettings}
  />;
  const messageRailStyle: React.CSSProperties = {
    width: screens.md ? "100%" : "calc(100% - 8px)",
    marginInline: "auto"
  };

  const bubbleItems = messages.map((message): BubbleItemType => {
    if (message.role === "user") {
      return {
        key: message.id,
        role: "user",
        content: message.text ?? "",
        placement: "end",
        variant: "filled",
        styles: { root: messageRailStyle }
      };
    }
    const selectedIndex = Math.max(0, message.generations.findIndex((item) => item.id === message.activeGenerationId));
    const generation = message.generations[selectedIndex];
    if (!generation) return {
      key: message.id,
      role: "ai",
      variant: "borderless",
      content: message.text ?? "",
      styles: { root: messageRailStyle }
    };
    const text = blockText(generation, ["text", "refusal"]);
    const reasoning = blockText(generation, ["reasoning"]);
    const active = message.activeGenerationId === liveGenerationId;
    return {
      key: message.id,
      role: "ai",
      variant: "borderless",
      streaming: active,
      loading: !reasoning && !text && (generation.status === "queued" || generation.status === "running"),
      styles: { root: messageRailStyle },
      content: <AssistantContent
        key={generation.id}
        generation={generation}
        active={active}
        colorScheme={colorScheme}
        collapsePolicy={uiPreferences.reasoningCollapsePolicy}
      />,
      footer: <MessageFooter
        message={message}
        generation={generation}
        selectedIndex={selectedIndex}
        active={active}
        mobile={mobileLayout}
        onRetry={() => void retry(message.id)}
        onSelect={async (generationId) => {
          await api.selectGeneration(message.id, generationId);
          if (currentId) await loadMessages(currentId);
        }}
      />
    };
  });

  const headerMenu = current && {
    items: [
      {
        key: "context",
        label: "上下文策略",
        children: CONTEXT_POLICIES.map((policy) => ({ key: policy.value, label: policy.label }))
      },
      { key: "execution-settings", label: "会话执行设置" },
      { key: "restore-agent", label: "恢复 Agent 默认", disabled: !Object.keys(current.executionOverrides).length },
      { type: "divider" as const },
      { key: "delete", label: "删除会话", icon: <DeleteOutlined />, danger: true }
    ],
    selectedKeys: [current.contextPolicy],
    onClick: async ({ key }: { key: string }) => {
      if (key === "delete") {
        setDeleteTarget(current);
      } else if (CONTEXT_POLICIES.some((policy) => policy.value === key)) {
        await patchConversation(current, {
          executionOverrides: { ...current.executionOverrides, contextPolicy: key as ContextPolicy }
        });
      } else if (key === "restore-agent") {
        await patchConversation(current, { executionOverrides: {} });
      } else if (key === "execution-settings") {
        setExecutionOpen(true);
      }
    }
  };

  const persistentSidebarOpen = !compactSidebar && !uiPreferences.sidebarCollapsed;
  const openSidebarButton = !persistentSidebarOpen;

  return <AppTheme colorScheme={colorScheme}>
      <Layout className="app-layout">
        {persistentSidebarOpen && <Sider width={260} theme={colorScheme}>{sidebar}</Sider>}
        <Layout className="chat-layout">
          <Header className={current ? "chat-header" : "chat-header chat-header-welcome"}>
            <Badge className="task-badge" count={tasks.filter((task) => ["queued", "starting", "running"].includes(task.status)).length} size="small">
              <Button className="task-button" type="text" icon={<CodeOutlined />} aria-label="后台任务" onClick={() => setTasksOpen(true)} />
            </Badge>
            {openSidebarButton && <Button
              className="sidebar-open-button"
              type="text"
              icon={compactSidebar ? <MenuOutlined /> : <MenuUnfoldOutlined />}
              aria-label="打开会话栏"
              onClick={() => compactSidebar
                ? setSidebarDrawerOpen(true)
                : updateUiPreferences({ ...uiPreferences, sidebarCollapsed: false })}
            />}
            {current && <Flex align="center" gap="small" className="header-rail">
              <div className="conversation-title-slot">
                {titleEditing ? <Input
                  autoFocus
                  className="conversation-title-input"
                  aria-label="会话标题"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => void commitTitle()}
                  onPressEnter={(event) => event.currentTarget.blur()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setTitleDraft(current.title);
                      setTitleEditing(false);
                    }
                  }}
                /> : <Button
                  type="text"
                  className="conversation-title-button"
                  onClick={() => { setTitleDraft(current.title); setTitleEditing(true); }}
                ><Text strong ellipsis>{current.title}</Text></Button>}
              </div>
              {agentSelector}
              {headerMenu && <Dropdown menu={headerMenu} trigger={["click"]}>
                <Button className="header-menu-button" type="text" icon={<MoreOutlined />} aria-label="会话操作" />
              </Dropdown>}
            </Flex>}
          </Header>
          <Content className="chat-content">
            {!boot.connections.length ? <EmptyState title="先添加一个模型连接" description="当前没有可用连接。" action="打开设置" onAction={() => setSettingsOpen(true)} />
              : !boot.models.some((model) => model.enabled) ? <EmptyState title="连接已建立，还需要模型" description="当前没有已启用模型。" action="管理模型" onAction={() => setSettingsOpen(true)} />
                : !current ? <WelcomeComposer
                  error={error}
                  draft={draft}
                  ready={Boolean(selectedAgent) && selectedModelAvailable}
                  mobile={mobileLayout}
                  agent={selectedAgent}
                  userName={selectedAgent?.userProfile.displayName ?? boot.settings.userProfile.displayName}
                  agentSelector={agentSelector}
                  greetingIndex={greetingIndex}
                  modelSelector={welcomeModelSelector}
                  effortControl={welcomeEffortControl}
                  contextSelector={contextSelector}
                  mobileToolbar={mobileComposerToolbar}
                  onGreetingIndex={setGreetingIndex}
                  onDraftChange={setDraft}
                  onSubmit={(value) => void send(value)}
                  onDismissError={() => setError("")}
                /> : <>
                  <div className="message-stage">
                    {!messages.length ? <EmptyState title={selectedModel?.displayName ?? "请选择模型"} description="输入消息开始对话。" />
                      : <Bubble.List
                        className="message-list"
                        items={bubbleItems}
                        autoScroll
                        styles={{ root: { height: "100%" }, scroll: { paddingBlock: mobileLayout ? "16px 24px" : "24px 32px" } }}
                      />}
                  </div>
                  <div className="composer-rail">
                    {current && !selectedAgent && <Alert type="error" showIcon title="当前 Agent 已删除，请重新选择" />}
                    {current && !selectedModelAvailable && <Alert type="error" showIcon title="当前模型已失效或不可用，请重新选择" />}
                    {error && <Alert type="error" showIcon closable title={error} onClose={() => setError("")} />}
                    {pendingApprovals.length > 0 ? <ApprovalPanel
                      pendingApprovals={pendingApprovals}
                      loading={Boolean(approvalActionId)}
                      onRespond={(approved) => void respondToToolApproval(pendingApprovals[0]!, approved)}
                    /> : <Sender
                      value={draft}
                      disabled={!selectedAgent || !selectedModelAvailable}
                      loading={Boolean(liveGenerationId)}
                      placeholder={!selectedAgent ? "请先选择 Agent" : selectedModelAvailable ? "输入消息" : selectedModel ? "当前模型失效" : "请先选择模型"}
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      submitType="enter"
                      onChange={setDraft}
                      onSubmit={(value) => void send(value)}
                      onCancel={() => liveGenerationId && void api.cancel(liveGenerationId)}
                      footer={mobileLayout ? mobileComposerToolbar : desktopComposerToolbar}
                    />}
                  </div>
                </>}
          </Content>
        </Layout>
      </Layout>

      <Drawer
        title="llm-chat"
        placement="left"
        size="min(320px, 88vw)"
        open={sidebarDrawerOpen}
        onClose={() => setSidebarDrawerOpen(false)}
        styles={{
          header: { paddingTop: "max(16px, env(safe-area-inset-top))" },
          body: { padding: 0, paddingBottom: "env(safe-area-inset-bottom)" }
        }}
      >
        {sidebar}
      </Drawer>
      {settingsOpen && <Suspense fallback={<Spin fullscreen />}><SettingsPanel
          open
          settings={boot.settings}
          agents={boot.agents}
          connections={boot.connections}
          models={boot.models}
          uiPreferences={uiPreferences}
          onUiPreferences={updateUiPreferences}
          onClose={() => setSettingsOpen(false)}
          onRefresh={refreshBoot}
          onSettings={(settings) => setBoot({ ...boot, settings })}
        /></Suspense>}
      <Modal
        open={Boolean(deleteTarget)}
        title="删除会话"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onCancel={() => setDeleteTarget(null)}
        onOk={async () => {
          if (!deleteTarget) return;
          await api.deleteConversation(deleteTarget.id);
          if (deleteTarget.id === currentId) navigate(null);
          setDeleteTarget(null);
          await refreshBoot();
        }}
      >
        删除会话“{deleteTarget?.title}”？此操作无法恢复。
      </Modal>
      {current && selectedAgent && <ConversationOverridesModal
        open={executionOpen}
        conversation={current}
        agent={selectedAgent}
        models={boot.models}
        onClose={() => setExecutionOpen(false)}
        onSave={async (executionOverrides) => {
          await patchConversation(current, { executionOverrides });
          setExecutionOpen(false);
        }}
      />}
      <WorkspaceBrowser
        open={workspaceOpen}
        value={current?.workspacePath ?? newWorkspacePath}
        onClose={() => setWorkspaceOpen(false)}
        onSelect={async (workspacePath) => {
          if (current) await patchConversation(current, { workspacePath });
          else setNewWorkspacePath(workspacePath);
          const settings = await api.updateSettings({ lastWorkspacePath: workspacePath });
          setBoot((value) => value ? { ...value, settings } : value);
          setWorkspaceOpen(false);
        }}
      />
      <TaskDrawer open={tasksOpen} tasks={tasks} currentConversationId={currentId} onClose={() => setTasksOpen(false)} onRefresh={refreshTasks} />
  </AppTheme>;
}

function AgentSelector({ value, agents, onChange }: {
  value: string | null;
  agents: AgentSummaryDto[];
  onChange: (agentId: string) => void;
}) {
  return <Select
    className="agent-selector"
    value={value}
    placeholder="选择 Agent"
    options={agents.map((agent) => ({
      value: agent.id,
      label: <Flex align="center" gap="small" className="agent-option">
        <Avatar size={24} src={agent.hasAvatar ? api.agentAvatarUrl(agent.id, agent.revision) : undefined}>
          {agent.name.slice(0, 1)}
        </Avatar>
        <Text ellipsis>{agent.name}</Text>
      </Flex>
    }))}
    onChange={onChange}
  />;
}

function MobileComposerToolbar({ agentSelector, modelSelector, executionControl, workspaceControl }: {
  agentSelector: React.ReactNode;
  modelSelector: React.ReactNode;
  executionControl: React.ReactNode;
  workspaceControl: React.ReactNode;
}) {
  return <Flex className="composer-toolbar composer-toolbar-mobile" align="center" gap={4} wrap={false}>
    <div className="composer-agent-control">{agentSelector}</div>
    <div className="composer-model-control">{modelSelector}</div>
    {executionControl}
    {workspaceControl}
  </Flex>;
}

function MobileExecutionControl({ reasoningEffort, contextPolicy, onReasoningEffort, onContextPolicy }: {
  reasoningEffort: ReasoningEffort;
  contextPolicy: ContextPolicy;
  onReasoningEffort: (value: ReasoningEffort) => void;
  onContextPolicy: (value: ContextPolicy) => void;
}) {
  const content = <Flex vertical gap="small" className="mobile-execution-popover">
    <label className="mobile-execution-field">
      <Text type="secondary">推理强度</Text>
      <Select<ReasoningEffort>
        className="mobile-reasoning-selector"
        aria-label="推理强度"
        value={reasoningEffort}
        options={REASONING_EFFORTS.map((value) => ({ label: value, value }))}
        onChange={onReasoningEffort}
      />
    </label>
    <label className="mobile-execution-field">
      <Text type="secondary">上下文策略</Text>
      <Select<ContextPolicy>
        className="mobile-context-selector"
        aria-label="上下文策略"
        value={contextPolicy}
        options={CONTEXT_POLICIES}
        onChange={onContextPolicy}
      />
    </label>
  </Flex>;

  return <Popover
    content={content}
    placement="topRight"
    trigger="click"
    arrow={false}
    styles={{ content: { width: "min(320px, calc(100vw - 24px))" } }}
  >
    <Tooltip title="调整推理强度和上下文策略">
      <Button
        type="text"
        size="small"
        className="mobile-execution-trigger"
        icon={<ControlOutlined />}
        aria-label="调整推理强度和上下文策略"
      />
    </Tooltip>
  </Popover>;
}

function WelcomeComposer({ error, draft, ready, mobile, agent, userName, agentSelector, greetingIndex, modelSelector, effortControl, contextSelector, mobileToolbar, onGreetingIndex, onDraftChange, onSubmit, onDismissError }: {
  error: string;
  draft: string;
  ready: boolean;
  mobile: boolean;
  agent: AgentSummaryDto | null;
  userName: string;
  agentSelector: React.ReactNode;
  greetingIndex: number;
  modelSelector: React.ReactNode;
  effortControl: React.ReactNode;
  contextSelector: React.ReactNode;
  mobileToolbar: React.ReactNode;
  onGreetingIndex: (index: number) => void;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onDismissError: () => void;
}) {
  const greetings = agent ? [agent.firstMessage, ...agent.alternateGreetings] : [];
  const greeting = greetings[greetingIndex] ?? "";
  return <Flex className="welcome-stage" align="center" justify="center">
    <Flex className="welcome-composer" vertical gap="large">
      <Flex className="welcome-agent" vertical align="center" gap="middle">
        <Avatar size={64} src={agent?.hasAvatar ? api.agentAvatarUrl(agent.id, agent.revision) : undefined}>
          {agent?.name.slice(0, 1) ?? "A"}
        </Avatar>
        <Typography.Title level={2}>{agent?.name ?? "选择 Agent"}</Typography.Title>
        {greeting && <Typography.Paragraph className="greeting-preview">
          {renderGreeting(greeting, agent?.name ?? "Agent", userName)}
        </Typography.Paragraph>}
        {greetings.length > 1 && <Space.Compact size="small">
          <Button type="text" icon={<LeftOutlined />} aria-label="上一条开场白" disabled={greetingIndex === 0} onClick={() => onGreetingIndex(greetingIndex - 1)} />
          <Button type="text" disabled>{greetingIndex + 1}/{greetings.length}</Button>
          <Button type="text" icon={<RightOutlined />} aria-label="下一条开场白" disabled={greetingIndex === greetings.length - 1} onClick={() => onGreetingIndex(greetingIndex + 1)} />
        </Space.Compact>}
      </Flex>
      <Flex className="welcome-input-stack" vertical gap="small">
        {!mobile && <Flex className="welcome-context" align="center" gap={4} wrap>
          {agentSelector}
          {modelSelector}
          {effortControl}
          {contextSelector}
        </Flex>}
        {error && <Alert type="error" showIcon closable title={error} onClose={onDismissError} />}
        <Sender
          value={draft}
          disabled={!ready}
          placeholder={ready ? "输入消息" : agent ? "请先选择模型" : "请先选择 Agent"}
          autoSize={{ minRows: mobile ? 1 : 2, maxRows: 8 }}
          submitType="enter"
          onChange={onDraftChange}
          onSubmit={onSubmit}
          {...(mobile ? {
            footer: mobileToolbar
          } : {})}
        />
      </Flex>
    </Flex>
  </Flex>;
}

function renderGreeting(value: string, characterName: string, userName: string): string {
  return value.replace(/\{\{char\}\}|<BOT>/gi, characterName).replace(/\{\{user\}\}|<USER>/gi, userName);
}

function ConversationOverridesModal({ open, conversation, agent, models, onClose, onSave }: {
  open: boolean;
  conversation: ConversationDto;
  agent: AgentSummaryDto;
  models: ModelDto[];
  onClose: () => void;
  onSave: (value: ConversationExecutionOverrides) => Promise<void>;
}) {
  const [value, setValue] = useState<ConversationExecutionOverrides>(conversation.executionOverrides);
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setValue(structuredClone(conversation.executionOverrides));
    void api.toolCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, [open, conversation.id, conversation.updatedAt]);
  const setTop = (key: "modelId" | "contextPolicy" | "reasoningEffort", next: string) => {
    setValue((currentValue) => {
      const output = { ...currentValue };
      if (next === "agent-default") delete output[key];
      else if (key === "modelId" && next === "unavailable") output.modelId = null;
      else Object.assign(output, { [key]: next });
      return output;
    });
  };
  const setCommon = (key: "temperature" | "topP" | "maxOutputTokens" | "stopSequences", next: number | string[] | null) => {
    setValue((currentValue) => {
      const common = { ...(currentValue.generation?.common ?? {}) };
      if (next === null || (Array.isArray(next) && !next.length)) delete common[key];
      else Object.assign(common, { [key]: next });
      const generation = { ...(currentValue.generation ?? {}) };
      if (Object.keys(common).length) generation.common = common;
      else delete generation.common;
      const output = { ...currentValue };
      if (Object.keys(generation).length) output.generation = generation;
      else delete output.generation;
      return output;
    });
  };
  const setProtocol = (key: "reasoningSummary" | "thinkingBudgetTokens", next: string | number | null) => {
    setValue((currentValue) => {
      const protocol = { ...(currentValue.generation?.protocol ?? {}) };
      if (next === null) delete protocol[key];
      else Object.assign(protocol, { [key]: next });
      const generation = { ...(currentValue.generation ?? {}) };
      if (Object.keys(protocol).length) generation.protocol = protocol;
      else delete generation.protocol;
      const output = { ...currentValue };
      if (Object.keys(generation).length) output.generation = generation;
      else delete output.generation;
      return output;
    });
  };
  const save = async () => {
    setSaving(true);
    try { await onSave(value); } finally { setSaving(false); }
  };
  return <Modal open={open} title="会话执行设置" okText="保存" cancelText="取消" confirmLoading={saving} onCancel={onClose} onOk={() => void save()}>
    <Flex vertical gap="middle" className="conversation-overrides">
      <Flex gap="middle" wrap>
        <label className="override-field"><Text type="secondary">模型</Text><Select
          aria-label="会话模型覆盖"
          value={Object.hasOwn(value, "modelId") ? value.modelId ?? "unavailable" : "agent-default"}
          options={[
            { label: `Agent 默认${agent.execution.modelId ? "" : "（未设置）"}`, value: "agent-default" },
            { label: "不选择模型", value: "unavailable" },
            ...models.filter((model) => model.enabled).map((model) => ({ label: model.displayName, value: model.id }))
          ]}
          onChange={(next) => setTop("modelId", next)}
        /></label>
        <label className="override-field"><Text type="secondary">上下文</Text><Select aria-label="会话上下文覆盖" value={value.contextPolicy ?? "agent-default"} options={[
          { label: `Agent 默认（${CONTEXT_POLICIES.find((item) => item.value === agent.execution.contextPolicy)?.label}）`, value: "agent-default" },
          ...CONTEXT_POLICIES
        ]} onChange={(next) => setTop("contextPolicy", next)} /></label>
        <label className="override-field"><Text type="secondary">推理强度</Text><Select aria-label="会话推理强度覆盖" value={value.reasoningEffort ?? "agent-default"} options={[
          { label: `Agent 默认（${agent.execution.reasoningEffort}）`, value: "agent-default" },
          ...["none", "low", "medium", "high", "xhigh", "max"].map((item) => ({ label: item, value: item }))
        ]} onChange={(next) => setTop("reasoningEffort", next)} /></label>
      </Flex>
      <Flex gap="middle" wrap>
        <label className="override-field"><Text type="secondary">Temperature</Text><InputNumber aria-label="会话 Temperature 覆盖" min={0} max={2} step={0.1} value={value.generation?.common?.temperature ?? null} placeholder="Agent 默认" onChange={(next) => setCommon("temperature", next)} /></label>
        <label className="override-field"><Text type="secondary">Top P</Text><InputNumber aria-label="会话 Top P 覆盖" min={0} max={1} step={0.05} value={value.generation?.common?.topP ?? null} placeholder="Agent 默认" onChange={(next) => setCommon("topP", next)} /></label>
        <label className="override-field"><Text type="secondary">最大输出</Text><InputNumber aria-label="会话最大输出覆盖" min={1} max={1_000_000} value={value.generation?.common?.maxOutputTokens ?? null} placeholder="Agent 默认" onChange={(next) => setCommon("maxOutputTokens", next)} /></label>
      </Flex>
      <label><Text type="secondary">停止序列</Text><Input.TextArea aria-label="会话停止序列覆盖" rows={2} value={(value.generation?.common?.stopSequences ?? []).join("\n")} placeholder="Agent 默认" onChange={(event) => setCommon("stopSequences", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8))} /></label>
      <Flex gap="middle" wrap>
        <label className="override-field"><Text type="secondary">推理摘要</Text><Select aria-label="会话推理摘要覆盖" allowClear value={value.generation?.protocol?.reasoningSummary} placeholder="Agent 默认" options={["auto", "concise", "detailed"].map((item) => ({ label: item, value: item }))} onChange={(next) => setProtocol("reasoningSummary", next ?? null)} /></label>
        <label className="override-field"><Text type="secondary">Thinking token 预算</Text><InputNumber aria-label="会话 Thinking token 预算覆盖" min={1024} value={value.generation?.protocol?.thinkingBudgetTokens ?? null} placeholder="Agent 默认" onChange={(next) => setProtocol("thinkingBudgetTokens", next)} /></label>
      </Flex>
      {catalog.length > 0 && <div><Text type="secondary">工具</Text><Flex vertical gap="small" className="override-tools">
        {catalog.map((tool) => <Flex key={tool.name} align="center" justify="space-between" gap="middle">
          <Text ellipsis>{tool.label}</Text>
          <Select aria-label={`${tool.label} 覆盖`} size="small" value={value.tools?.[tool.name] === undefined ? "agent-default" : value.tools[tool.name] ? "enabled" : "disabled"} options={[
            { label: "Agent 默认", value: "agent-default" }, { label: "启用", value: "enabled" }, { label: "停用", value: "disabled" }
          ]} onChange={(next) => setValue((currentValue) => {
            const tools = { ...(currentValue.tools ?? {}) };
            if (next === "agent-default") delete tools[tool.name];
            else tools[tool.name] = next === "enabled";
            const output = { ...currentValue };
            if (Object.keys(tools).length) output.tools = tools;
            else delete output.tools;
            return output;
          })} />
        </Flex>)}
      </Flex></div>}
      <Button onClick={() => setValue({})}>恢复 Agent 默认</Button>
    </Flex>
  </Modal>;
}

function SidebarContent({ conversations, currentId, showBrand, showCollapse, onCollapse, onCreate, onNavigate, onDelete, onSettings }: {
  conversations: ConversationDto[];
  currentId: string | null;
  showBrand: boolean;
  showCollapse: boolean;
  onCollapse: () => void;
  onCreate: () => void;
  onNavigate: (id: string) => void;
  onDelete: (conversation: ConversationDto) => void;
  onSettings: () => void;
}) {
  return <Flex vertical className="sidebar-content" gap="small">
    {(showBrand || showCollapse) && <Flex className="sidebar-header" align="center" justify="space-between">
      {showBrand && <Text strong>llm-chat</Text>}
      {showCollapse && <Button type="text" icon={<MenuFoldOutlined />} aria-label="收起会话栏" onClick={onCollapse} />}
    </Flex>}
    <Conversations
      className="conversation-list"
      {...(currentId ? { activeKey: currentId } : {})}
      creation={{ label: "新对话", onClick: onCreate }}
      items={conversations.map((conversation) => ({ key: conversation.id, label: conversation.title }))}
      onActiveChange={(id) => onNavigate(id)}
      menu={(item) => ({ items: [{ key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true, onClick: () => {
        const conversation = conversations.find((value) => value.id === item.key);
        if (conversation) onDelete(conversation);
      } }] })}
    />
    <Button type="text" block icon={<SettingOutlined />} onClick={onSettings}>设置</Button>
  </Flex>;
}

function EmptyState({ title, description, action, onAction }: { title: string; description: string; action?: string; onAction?: () => void }) {
  return <Flex className="empty-state" align="center" justify="center">
    <Welcome title={title} description={description} extra={action && <Button type="primary" onClick={onAction}>{action}</Button>} />
  </Flex>;
}

function AssistantContent({ generation, active, colorScheme, collapsePolicy }: {
  generation: GenerationDto;
  active: boolean;
  colorScheme: ColorScheme;
  collapsePolicy: ReasoningCollapsePolicy;
}) {
  const text = blockText(generation, ["text", "refusal"]);
  const reasoning = blockText(generation, ["reasoning"]);
  const unsupported = generation.blocks.filter((block) => block.type === "unsupported");
  const [expanded, setExpanded] = useState(() => initialReasoningExpanded(collapsePolicy, active, Boolean(text)));
  const answerSeen = useRef(Boolean(text));

  useEffect(() => {
    setExpanded(initialReasoningExpanded(collapsePolicy, active, Boolean(text)));
    answerSeen.current = Boolean(text);
  }, [collapsePolicy, generation.id]);

  useEffect(() => {
    if (collapsePolicy === "collapse-on-answer" && !answerSeen.current && text) setExpanded(false);
    if (text) answerSeen.current = true;
  }, [collapsePolicy, text]);

  return <Flex vertical gap="small">
    {reasoning && <Think
      title={active && !text ? "正在推理" : "推理过程"}
      loading={active && !text}
      expanded={expanded}
      onExpand={setExpanded}
    >
      <Suspense fallback={<div className="markdown-fallback">{reasoning}</div>}><Markdown colorScheme={colorScheme} streaming={active}>{reasoning}</Markdown></Suspense>
    </Think>}
    {generation.toolCalls.map((toolCall) => <ToolCallView
      key={toolCall.id}
      toolCall={toolCall}
    />)}
    {text && <Suspense fallback={<div className="markdown-fallback">{text}</div>}><Markdown colorScheme={colorScheme} streaming={active}>{text}</Markdown></Suspense>}
    {unsupported.map((block) => <Alert key={block.id} type="warning" showIcon title={block.content} />)}
    {generation.error && <Alert type="error" showIcon title={generation.error.message} />}
  </Flex>;
}

function ToolCallView({ toolCall }: {
  toolCall: ToolCallDto;
}) {
  const body = <Flex vertical gap="small">
    <div>
      <Text type="secondary">参数</Text>
      <pre className="tool-payload">{prettyJson(toolCall.arguments)}</pre>
    </div>
    {(toolCall.output || toolCall.error) && <div>
      <Text type="secondary">{toolCall.error ? "错误" : "结果"}</Text>
      <pre className="tool-payload">{prettyJson(toolCall.error ?? toolCall.output ?? "")}</pre>
    </div>}
  </Flex>;
  return <Collapse
    size="small"
    className="tool-call"
    items={[{
      key: toolCall.id,
      label: <Flex align="center" gap="small"><CodeOutlined /><Text>{toolName(toolCall.name)}</Text></Flex>,
      extra: <Tag color={toolStatusColor(toolCall.approvalState)}>{toolStatusName(toolCall.approvalState)}</Tag>,
      children: body
    }]}
  />;
}

function ApprovalPanel({ pendingApprovals, loading, onRespond }: {
  pendingApprovals: ToolCallDto[];
  loading: boolean;
  onRespond: (approved: boolean) => void;
}) {
  const toolCall = pendingApprovals[0];
  if (!toolCall) return null;
  return <section className="approval-panel" aria-label="工具审批">
    <Flex className="approval-panel-header" align="center" justify="space-between" gap="small" wrap>
      <Flex className="approval-tool-heading" align="center" gap="small">
        <CodeOutlined />
        <Text strong ellipsis>{toolName(toolCall.name)}</Text>
        <Text type="secondary" ellipsis>{toolCall.name}</Text>
      </Flex>
      <Text type="secondary" className="approval-position">第 {1} 项，共 {pendingApprovals.length} 项</Text>
    </Flex>
    <Text type="secondary" className="approval-prompt">此工具调用需要你的许可</Text>
    <pre className="approval-payload" aria-label="工具参数">{prettyJson(toolCall.arguments)}</pre>
    <Flex className="approval-actions" justify="end" gap="small" wrap>
      <Button
        type="primary"
        icon={<CheckOutlined />}
        loading={loading}
        disabled={loading}
        onClick={() => onRespond(true)}
      >允许</Button>
      <Button
        danger
        icon={<CloseOutlined />}
        loading={loading}
        disabled={loading}
        onClick={() => onRespond(false)}
      >拒绝</Button>
    </Flex>
  </section>;
}

function MessageFooter({ message, generation, selectedIndex, active, mobile, onRetry, onSelect }: {
  message: MessageDto;
  generation: GenerationDto;
  selectedIndex: number;
  active: boolean;
  mobile: boolean;
  onRetry: () => void;
  onSelect: (id: string) => Promise<void>;
}) {
  const text = blockText(generation, ["text", "refusal"]);
  const detail = message.generatedModel
    ? `${protocolShortName(message.generatedModel.protocol)} · ${message.generatedModel.modelKey} · ${message.generatedModel.connectionName}${generation.stopReason ? ` · ${generation.stopReason}` : ""}`
    : undefined;
  const actions = <Actions items={[
      { key: "copy", label: "复制", icon: <CopyOutlined />, onItemClick: () => void navigator.clipboard.writeText(text) },
      { key: "retry", label: "重新生成", icon: <SyncOutlined spin={active} />, onItemClick: () => { if (!active) onRetry(); } }
    ]} />;
  const versions = message.generations.length > 1 ? <Space.Compact size="small">
      <Button type="text" title="上一版本" icon={<LeftOutlined />} disabled={selectedIndex === 0} onClick={() => void onSelect(message.generations[selectedIndex - 1]!.id)} />
      <Button type="text" disabled>{selectedIndex + 1}/{message.generations.length}</Button>
      <Button type="text" title="下一版本" icon={<RightOutlined />} disabled={selectedIndex === message.generations.length - 1} onClick={() => void onSelect(message.generations[selectedIndex + 1]!.id)} />
    </Space.Compact> : null;
  const metadata = <>
    {generation.generatedAgent && <Text type="secondary">{generation.generatedAgent.name} r{generation.generatedAgent.revision}</Text>}
    {message.generatedModel && <Tooltip title={detail}><Text type="secondary" ellipsis className="message-model-label">{message.generatedModel.displayName}</Text></Tooltip>}
    {generation.usage.inputTokens !== undefined && <Text type="secondary" className="message-usage-fact">输入 {generation.usage.inputTokens.toLocaleString()}</Text>}
    {generation.usage.outputTokens !== undefined && <Text type="secondary" className="message-usage-fact">输出 {generation.usage.outputTokens.toLocaleString()}</Text>}
    {validCacheRate(generation.usage.inputTokens, generation.usage.cachedInputTokens) !== null && <Tooltip title={cacheUsageDetail(
      generation.usage.cachedInputTokens!, generation.usage.inputTokens!, generation.usage.totalTokens
    )}>
      <Text type="secondary" className="message-usage-fact">缓存 {validCacheRate(generation.usage.inputTokens, generation.usage.cachedInputTokens)}%</Text>
    </Tooltip>}
    {generation.usage.inputTokens === undefined && generation.usage.outputTokens === undefined && generation.usage.totalTokens !== undefined
      && <Text type="secondary" className="message-usage-fact">{generation.usage.totalTokens.toLocaleString()} tokens</Text>}
    {generation.status !== "completed" && <Tag color={statusColor(generation.status)}>{statusName(generation.status)}</Tag>}
    {generation.context?.omittedMessages ? <Text type="secondary">省略 {generation.context.omittedMessages} 条</Text> : null}
  </>;
  if (mobile) return <Flex className="message-meta message-meta-mobile" vertical gap={4}>
    <Flex className="message-meta-actions" align="center" gap="small" wrap>{actions}{versions}</Flex>
    <Flex className="message-meta-details" align="center" gap="small" wrap>{metadata}</Flex>
  </Flex>;
  return <Flex className="message-meta" align="center" gap="small" wrap>
    {actions}
    {versions}
    {metadata}
  </Flex>;
}

function validCacheRate(inputTokens: number | undefined, cachedInputTokens: number | undefined): number | null {
  if (inputTokens === undefined || cachedInputTokens === undefined || !Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)
    || inputTokens <= 0 || cachedInputTokens < 0 || cachedInputTokens > inputTokens) return null;
  return Math.round(cachedInputTokens / inputTokens * 100);
}

function cacheUsageDetail(cachedInputTokens: number, inputTokens: number, totalTokens: number | undefined): string {
  const inputDetail = `${cachedInputTokens.toLocaleString()} 个缓存输入 tokens / ${inputTokens.toLocaleString()} 个输入 tokens`;
  return totalTokens === undefined ? inputDetail : `${inputDetail} / ${totalTokens.toLocaleString()} 个总 tokens`;
}

function WorkspaceBrowser({ open, value, onClose, onSelect }: {
  open: boolean;
  value: string | null;
  onClose: () => void;
  onSelect: (path: string | null) => Promise<void>;
}) {
  const [path, setPath] = useState(value ?? "/");
  const [listing, setListing] = useState<Awaited<ReturnType<typeof api.directories>> | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const load = async (nextPath: string) => {
    try { const next = await api.directories(nextPath); setListing(next); setPath(next.path); setError(""); }
    catch (reason) { setError(messageOf(reason)); }
  };
  useEffect(() => { if (open) void load(value ?? "/"); }, [open, value]);
  const segments = path.split("/").filter(Boolean);
  const breadcrumb = [{ title: <Button type="link" size="small" onClick={() => void load("/")}>/</Button> }, ...segments.map((segment, index) => ({
    title: <Button type="link" size="small" onClick={() => void load(`/${segments.slice(0, index + 1).join("/")}`)}>{segment}</Button>
  }))];
  return <Modal open={open} title="选择工作目录" okText="使用此目录" cancelText="取消" width={720} onCancel={onClose}
    onOk={() => void onSelect(listing?.path ?? path)} footer={(_, { OkBtn, CancelBtn }) => <Flex justify="space-between">
      <Button onClick={() => void onSelect(null)}>不绑定目录</Button><Space><CancelBtn /><OkBtn /></Space>
    </Flex>}>
    <Flex vertical gap="small" className="workspace-browser">
      <Input.Search value={path} onChange={(event) => setPath(event.target.value)} onSearch={(next) => void load(next)} enterButton="打开" />
      <Flex align="center" justify="space-between" gap="small"><Breadcrumb items={breadcrumb} />
        <Checkbox checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)}>隐藏目录</Checkbox></Flex>
      {error && <Alert type="error" showIcon title={error} />}
      {(() => {
        const entries = (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden);
        return entries.length ? <Listy className="directory-list" items={entries} rowKey="path" virtual={false}
          itemRender={(entry) => <button type="button" onClick={() => void load(entry.path)} className="directory-row">
            <Space><FolderOpenOutlined /><Text>{entry.name}</Text></Space>
          </button>} /> : <div className="directory-list list-empty">没有子目录</div>;
      })()}
      <Space.Compact block><Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新目录名称" />
        <Button icon={<FolderOpenOutlined />} disabled={!newName.trim()} onClick={async () => {
          try { await api.createDirectory(`${listing?.path ?? path}/${newName.trim()}`); setNewName(""); await load(listing?.path ?? path); }
          catch (reason) { setError(messageOf(reason)); }
        }}>创建</Button></Space.Compact>
    </Flex>
  </Modal>;
}

function TaskDrawer({ open, tasks, currentConversationId, onClose, onRefresh }: {
  open: boolean;
  tasks: BackgroundTaskDto[];
  currentConversationId: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [all, setAll] = useState(false);
  const visible = all || !currentConversationId ? tasks : tasks.filter((task) => task.conversationId === currentConversationId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = visible.find((task) => task.id === selectedId) ?? visible[0] ?? null;
  const [raw, setRaw] = useState("");
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.backgroundTask>>["events"]>([]);
  useEffect(() => {
    if (!open || !selected) return;
    void Promise.all([readRetainedTaskOutput(selected), api.backgroundTask(selected.id)])
      .then(([output, detail]) => { setRaw(output); setEvents(detail.events); }).catch(() => {});
  }, [open, selected?.id, selected?.outputCursor, selected?.earliestCursor]);
  return <Drawer open={open} onClose={onClose} title={<Flex align="center" justify="space-between"><Text strong>后台任务</Text>
    <Space><Text type="secondary">全部</Text><Switch size="small" checked={all} onChange={setAll} /></Space></Flex>} size="min(920px, 100%)">
    <Flex className="task-drawer-layout" gap="middle" vertical={false}>
      {visible.length ? <Listy className="task-list" items={visible} rowKey="id" virtual={false} itemRender={(task) => <button type="button"
        className={selected?.id === task.id ? "task-row task-row-selected" : "task-row"} onClick={() => setSelectedId(task.id)}>
        <Flex vertical gap={2}><Flex align="center" gap="small"><Tag color={task.overdue ? "warning" : taskStatusColor(task.status)}>{task.status}</Tag><Text ellipsis>{task.command}</Text></Flex>
          <Text type="secondary" ellipsis>{task.agentName} r{task.agentRevision} · {task.workspacePath}</Text></Flex>
      </button>} /> : <div className="task-list list-empty">没有后台任务</div>}
      <div className="task-detail">
        {selected ? <Flex vertical gap="small">
          <Flex align="center" justify="space-between" gap="small"><Text strong ellipsis>{selected.command}</Text>
            {["queued", "starting", "running"].includes(selected.status) && <Button danger icon={<StopOutlined />} onClick={async () => {
              await api.stopBackgroundTask(selected.id, "用户从任务抽屉停止"); await onRefresh();
            }}>停止</Button>}</Flex>
          <Text type="secondary">{selected.mode.toUpperCase()} · {selected.workspacePath}{selected.overdue ? " · 已超过预期时长" : ""}</Text>
          {selected.mode === "pty" ? <Suspense fallback={<pre className="task-output">{raw || "暂无输出"}</pre>}><TaskTerminal raw={raw} /></Suspense> : <pre className="task-output">{raw || "暂无输出"}</pre>}
          {events.some((event) => event.reason) && <Collapse size="small" items={[{ key: "audit", label: "审计记录", children: <ul className="task-audit-list">
            {events.filter((event) => event.reason).map((event) => <li key={event.id}><Text>{event.type}：{event.reason}</Text></li>)}
          </ul> }]} />}
        </Flex> : <Flex align="center" justify="center"><Text type="secondary">选择任务查看输出</Text></Flex>}
      </div>
    </Flex>
  </Drawer>;
}

function taskStatusColor(status: BackgroundTaskDto["status"]): string {
  if (status === "running" || status === "starting") return "processing";
  if (status === "completed") return "success";
  if (status === "failed" || status === "timed_out") return "error";
  return "default";
}

async function readRetainedTaskOutput(task: BackgroundTaskDto): Promise<string> {
  let cursor = task.earliestCursor;
  let raw = "";
  while (cursor < task.outputCursor) {
    const page = await api.backgroundOutput(task.id, cursor, 32 * 1024);
    raw += page.raw;
    if (page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return raw;
}

function replace<T extends { id: string }>(items: T[], value: T): T[] { return items.map((item) => item.id === value.id ? value : item); }
function conversationFromPath(): string | null { return location.pathname.match(/^\/c\/([0-9a-f-]+)$/i)?.[1] ?? null; }
function messageOf(value: unknown) { return value instanceof Error ? value.message : "操作失败"; }
function statusName(value: GenerationDto["status"]) { return ({ queued: "等待中", running: "生成中", "waiting-approval": "等待审批", completed: "完成", stopped: "已停止", failed: "失败", interrupted: "已中断" } as const)[value]; }
function statusColor(value: GenerationDto["status"]): string { return ({ queued: "default", running: "processing", "waiting-approval": "warning", completed: "success", stopped: "warning", failed: "error", interrupted: "warning" } as const)[value]; }
function toolStatusName(value: ToolCallDto["approvalState"]) { return ({ auto: "待执行", pending: "等待审批", approved: "已允许", denied: "已拒绝", running: "执行中", completed: "完成", failed: "失败" } as const)[value]; }
function toolStatusColor(value: ToolCallDto["approvalState"]): string { return ({ auto: "default", pending: "warning", approved: "processing", denied: "error", running: "processing", completed: "success", failed: "error" } as const)[value]; }
function toolName(value: string) { return value.startsWith("mcp__") ? value.split("__").slice(1).join(" / ") : value.replace(/^workspace_/, "工作区 / "); }
function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
