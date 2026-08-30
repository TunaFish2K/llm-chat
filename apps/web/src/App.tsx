import type {
  AppSettings,
  ConnectionDto,
  ContextPolicy,
  ConversationDto,
  GenerationDto,
  MessageDto,
  ModelDto,
  ReasoningEffort,
  ToolCallDto
} from "@llm-chat/contracts";
import {
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  LeftOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  RightOutlined,
  SettingOutlined,
  SyncOutlined
} from "@ant-design/icons";
import { Actions, Bubble, Conversations, Sender, Think, Welcome, type BubbleItemType } from "@ant-design/x";
import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Dropdown,
  Flex,
  Grid,
  Input,
  Layout,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, generationEvents } from "./api";
import { Markdown } from "./Markdown";
import { ModelSelector, isModelUsable, protocolShortName } from "./ModelSelector";
import { ReasoningEffortControl } from "./ReasoningEffortControl";
import { SettingsPanel } from "./SettingsPanel";
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

interface BootData {
  settings: AppSettings;
  connections: ConnectionDto[];
  models: ModelDto[];
  conversations: ConversationDto[];
}

const CONTEXT_POLICIES: Array<{ label: string; value: ContextPolicy }> = [
  { label: "裁剪", value: "trim" },
  { label: "摘要", value: "summarize" },
  { label: "完整", value: "full" }
];

export function App() {
  const [boot, setBoot] = useState<BootData | null>(null);
  const [currentId, setCurrentId] = useState(() => conversationFromPath());
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [newModelId, setNewModelId] = useState<string | null>(null);
  const [liveGenerationId, setLiveGenerationId] = useState<string | null>(null);
  const [reasoningSaving, setReasoningSaving] = useState(false);
  const [toolActionIds, setToolActionIds] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationDto | null>(null);
  const [error, setError] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const draftReady = useRef(false);
  const reasoningSaveRef = useRef<Promise<void> | null>(null);
  const reasoningSaveSequence = useRef(0);
  const screens = Grid.useBreakpoint();
  const compactSidebar = !screens.lg;
  const mobileLayout = !screens.md;

  const refreshBoot = useCallback(async () => {
    const [settings, connections, models, conversations] = await Promise.all([
      api.settings(), api.connections(), api.models(), api.conversations()
    ]);
    setBoot({ settings, connections, models, conversations });
  }, []);

  useEffect(() => { void refreshBoot().catch((value) => setError(messageOf(value))); }, [refreshBoot]);
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
  const enabledModels = useMemo(() => boot?.models.filter((model) => model.enabled) ?? [], [boot?.models]);
  const fallbackModelId = enabledModels.some((model) => model.id === boot?.settings.defaultModelId)
    ? boot?.settings.defaultModelId ?? null
    : enabledModels[0]?.id ?? null;
  const selectedModelId = current ? current.modelId : newModelId ?? fallbackModelId;
  const selectedModel = boot?.models.find((item) => item.id === selectedModelId) ?? null;
  const selectedModelAvailable = isModelUsable(selectedModel, boot?.connections ?? []);
  const pendingPolicy = boot?.settings.defaultContextPolicy ?? "trim";
  const uiPreferences = boot?.settings.uiPreferences ?? defaultUiPreferences;
  const waitingToolApproval = messages.some((message) => message.generations.some((generation) =>
    generation.id === message.activeGenerationId && generation.status === "waiting-approval"
  ));

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
    setNewModelId(null);
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

  const persistReasoningEffort = (reasoningEffort: ReasoningEffort) => {
    if (!boot || reasoningEffort === boot.settings.reasoningEffort) return;
    const previous = boot.settings.reasoningEffort;
    const sequence = ++reasoningSaveSequence.current;
    setBoot({ ...boot, settings: { ...boot.settings, reasoningEffort } });
    setReasoningSaving(true);
    const predecessor = reasoningSaveRef.current?.catch(() => {}) ?? Promise.resolve();
    const task = predecessor.then(async () => {
      const settings = await api.updateSettings({ reasoningEffort });
      if (reasoningSaveSequence.current === sequence) {
        setBoot((value) => value ? { ...value, settings } : value);
      }
    }).catch((value) => {
      if (reasoningSaveSequence.current === sequence) {
        setBoot((currentBoot) => currentBoot ? {
          ...currentBoot,
          settings: { ...currentBoot.settings, reasoningEffort: previous }
        } : currentBoot);
        setError(messageOf(value));
      }
      throw value;
    }).finally(() => {
      if (reasoningSaveRef.current === task) {
        reasoningSaveRef.current = null;
        setReasoningSaving(false);
      }
    });
    reasoningSaveRef.current = task;
    void task.catch(() => {});
  };

  const chooseModel = (modelId: string) => {
    if (!boot) return;
    if (!current) {
      setNewModelId(modelId);
      return;
    }
    void patchConversation(current, { modelId });
  };

  const openSettings = () => {
    setSidebarDrawerOpen(false);
    setSettingsOpen(true);
  };

  const send = async (text = draft) => {
    if (!boot || !selectedModelAvailable || !selectedModel || !text.trim() || liveGenerationId || waitingToolApproval) return;
    setError("");
    try {
      await reasoningSaveRef.current;
      const content = text.trim();
      setDraft("");
      if (!currentId) {
        const started = await api.startConversation({
          text: content,
          modelId: selectedModel.id,
          contextPolicy: pendingPolicy
        });
        setBoot((value) => value ? { ...value, conversations: [started.conversation, ...value.conversations] } : value);
        setNewModelId(null);
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

  const retry = async (messageId: string) => {
    if (liveGenerationId || waitingToolApproval) return;
    try {
      await reasoningSaveRef.current;
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
    value={boot.settings.reasoningEffort}
    mobile={compactSidebar}
    saving={reasoningSaving}
    onChange={persistReasoningEffort}
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
    value={boot.settings.reasoningEffort}
    mobile={compactSidebar}
    saving={reasoningSaving}
    onChange={persistReasoningEffort}
    placement={mobileLayout ? "topLeft" : "bottomLeft"}
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
    if (!generation) return { key: message.id, role: "ai", content: "", loading: true, styles: { root: messageRailStyle } };
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
        toolActionIds={toolActionIds}
        onToolApproval={async (toolCall, approved) => {
          setToolActionIds((value) => new Set(value).add(toolCall.id));
          try {
            const result = await api.approveTool(toolCall.id, approved);
            if (result.resumed) setLiveGenerationId(result.generationId);
            if (currentId) await loadMessages(currentId);
          } catch (value) {
            setError(messageOf(value));
          } finally {
            setToolActionIds((value) => {
              const next = new Set(value);
              next.delete(toolCall.id);
              return next;
            });
          }
        }}
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
      { type: "divider" as const },
      { key: "delete", label: "删除会话", icon: <DeleteOutlined />, danger: true }
    ],
    selectedKeys: [current.contextPolicy],
    onClick: async ({ key }: { key: string }) => {
      if (key === "delete") {
        setDeleteTarget(current);
      } else if (CONTEXT_POLICIES.some((policy) => policy.value === key)) {
        await patchConversation(current, { contextPolicy: key as ContextPolicy });
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
                  ready={selectedModelAvailable}
                  mobile={mobileLayout}
                  modelSelector={welcomeModelSelector}
                  effortControl={welcomeEffortControl}
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
                    {current && !selectedModelAvailable && <Alert type="error" showIcon message="当前模型已失效或不可用，请重新选择" />}
                    {error && <Alert type="error" showIcon closable message={error} onClose={() => setError("")} />}
                    <Sender
                      value={draft}
                      disabled={!selectedModelAvailable || waitingToolApproval}
                      loading={Boolean(liveGenerationId)}
                      placeholder={waitingToolApproval ? "请先处理上方的工具审批" : selectedModelAvailable ? "输入消息" : selectedModel ? "当前模型失效" : "请先选择模型"}
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      submitType="enter"
                      onChange={setDraft}
                      onSubmit={(value) => void send(value)}
                      onCancel={() => liveGenerationId && void api.cancel(liveGenerationId)}
                      footer={<Flex className="composer-toolbar" align="center" gap={4} wrap>
                        {modelSelector}
                        {effortControl}
                      </Flex>}
                    />
                  </div>
                </>}
          </Content>
        </Layout>
      </Layout>

      <Drawer
        title="llm-chat"
        placement="left"
        width="min(320px, 88vw)"
        open={sidebarDrawerOpen}
        onClose={() => setSidebarDrawerOpen(false)}
        styles={{
          header: { paddingTop: "max(16px, env(safe-area-inset-top))" },
          body: { padding: 0, paddingBottom: "env(safe-area-inset-bottom)" }
        }}
      >
        {sidebar}
      </Drawer>
      <SettingsPanel
        open={settingsOpen}
        settings={boot.settings}
        connections={boot.connections}
        models={boot.models}
        uiPreferences={uiPreferences}
        onUiPreferences={updateUiPreferences}
        onClose={() => setSettingsOpen(false)}
        onRefresh={refreshBoot}
        onSettings={(settings) => setBoot({ ...boot, settings })}
      />
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
  </AppTheme>;
}

function WelcomeComposer({ error, draft, ready, mobile, modelSelector, effortControl, onDraftChange, onSubmit, onDismissError }: {
  error: string;
  draft: string;
  ready: boolean;
  mobile: boolean;
  modelSelector: React.ReactNode;
  effortControl: React.ReactNode;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onDismissError: () => void;
}) {
  return <Flex className="welcome-stage" align="center" justify="center">
    <Flex className="welcome-composer" vertical gap="large">
      <Welcome className="welcome-prompt" variant="borderless" title="有什么可以帮你？" styles={{ root: { justifyContent: "center", textAlign: "center" } }} />
      <Flex className="welcome-input-stack" vertical gap="small">
        {!mobile && <Flex className="welcome-context" align="center" gap={4} wrap>
          {modelSelector}
          {effortControl}
        </Flex>}
        {error && <Alert type="error" showIcon closable message={error} onClose={onDismissError} />}
        <Sender
          value={draft}
          disabled={!ready}
          placeholder={ready ? "输入消息" : "请先选择模型"}
          autoSize={{ minRows: mobile ? 1 : 2, maxRows: 8 }}
          submitType="enter"
          onChange={onDraftChange}
          onSubmit={onSubmit}
          {...(mobile ? {
            footer: <Flex className="composer-toolbar" align="center" gap={4} wrap>
              {modelSelector}
              {effortControl}
            </Flex>
          } : {})}
        />
      </Flex>
    </Flex>
  </Flex>;
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

function AssistantContent({ generation, active, colorScheme, collapsePolicy, toolActionIds, onToolApproval }: {
  generation: GenerationDto;
  active: boolean;
  colorScheme: ColorScheme;
  collapsePolicy: ReasoningCollapsePolicy;
  toolActionIds: Set<string>;
  onToolApproval: (toolCall: ToolCallDto, approved: boolean) => Promise<void>;
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
      <Markdown colorScheme={colorScheme} streaming={active}>{reasoning}</Markdown>
    </Think>}
    {generation.toolCalls.map((toolCall) => <ToolCallView
      key={toolCall.id}
      toolCall={toolCall}
      loading={toolActionIds.has(toolCall.id)}
      onApproval={onToolApproval}
    />)}
    {text && <Markdown colorScheme={colorScheme} streaming={active}>{text}</Markdown>}
    {unsupported.map((block) => <Alert key={block.id} type="warning" showIcon message={block.content} />)}
    {generation.error && <Alert type="error" showIcon message={generation.error.message} />}
  </Flex>;
}

function ToolCallView({ toolCall, loading, onApproval }: {
  toolCall: ToolCallDto;
  loading: boolean;
  onApproval: (toolCall: ToolCallDto, approved: boolean) => Promise<void>;
}) {
  const pending = toolCall.approvalState === "pending";
  const body = <Flex vertical gap="small">
    <div>
      <Text type="secondary">参数</Text>
      <pre className="tool-payload">{prettyJson(toolCall.arguments)}</pre>
    </div>
    {(toolCall.output || toolCall.error) && <div>
      <Text type="secondary">{toolCall.error ? "错误" : "结果"}</Text>
      <pre className="tool-payload">{prettyJson(toolCall.error ?? toolCall.output ?? "")}</pre>
    </div>}
    {pending && <Flex gap="small">
      <Button type="primary" size="small" icon={<CheckOutlined />} loading={loading} onClick={() => void onApproval(toolCall, true)}>允许</Button>
      <Button size="small" danger icon={<CloseOutlined />} disabled={loading} onClick={() => void onApproval(toolCall, false)}>拒绝</Button>
    </Flex>}
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
    {message.generatedModel && <Tooltip title={detail}><Text type="secondary" ellipsis className="message-model-label">{message.generatedModel.displayName}</Text></Tooltip>}
    {generation.usage.totalTokens !== undefined && <Text type="secondary">{generation.usage.totalTokens.toLocaleString()} tokens</Text>}
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
