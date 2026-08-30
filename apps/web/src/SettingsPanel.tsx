import type {
  AgentDto,
  AgentInput,
  AgentSummaryDto,
  AppSettings,
  ConnectionDto,
  ConnectionInput,
  McpServerDto,
  McpServerInput,
  ModelCapabilities,
  ModelDto,
  ModelInput,
  ModelSettings,
  ProviderProtocol,
  ToolCatalogItemDto,
  ToolSettingsDto
} from "@llm-chat/contracts";
import { ApiOutlined, ArrowLeftOutlined, DeleteOutlined, DownloadOutlined, ImportOutlined, PlusOutlined, QuestionCircleOutlined, ReloadOutlined, SaveOutlined, ThunderboltOutlined, UploadOutlined } from "@ant-design/icons";
import {
  App as AntApp,
  Button,
  Checkbox,
  Collapse,
  Drawer,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  List,
  Menu,
  Select,
  Space,
  Switch,
  Tabs,
  Tooltip,
  Typography
} from "antd";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { UiPreferences } from "./uiPreferences";

const { Text, Title } = Typography;
const { TextArea } = Input;

interface Props {
  open: boolean;
  settings: AppSettings;
  agents?: AgentSummaryDto[];
  connections: ConnectionDto[];
  models: ModelDto[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSettings: (settings: AppSettings) => void;
  uiPreferences: UiPreferences;
  onUiPreferences: (preferences: UiPreferences) => void;
}

const defaults: Record<ProviderProtocol, string> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-chat": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1"
};

type Run = (action: () => Promise<unknown>, success: string) => Promise<boolean>;

export function SettingsPanel(props: Props) {
  const [busy, setBusy] = useState(false);
  const screens = Grid.useBreakpoint();
  const mobile = !screens.md;
  const { message } = AntApp.useApp();
  const run: Run = async (action, success) => {
    setBusy(true);
    try {
      await action();
      await props.onRefresh();
      void message.success(success);
      return true;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return <Drawer
    open={props.open}
    width={screens.lg ? 960 : "100%"}
    title={mobile
      ? <Title level={4}>设置</Title>
      : <Flex vertical><Title level={4}>设置</Title><Text type="secondary">Agent、模型、连接、工具与界面</Text></Flex>}
    onClose={props.onClose}
    destroyOnHidden
    styles={{
      header: { paddingTop: "max(16px, env(safe-area-inset-top))" },
      body: { paddingBottom: "max(24px, env(safe-area-inset-bottom))" }
    }}
  >
    <Tabs
      defaultActiveKey="agents"
      items={[
        { key: "agents", label: "Agent", children: <Agents agents={props.agents ?? []} models={props.models} settings={props.settings} busy={busy} mobile={mobile} run={run} /> },
        { key: "connections", label: "连接", children: <Connections connections={props.connections} busy={busy} mobile={mobile} run={run} /> },
        { key: "models", label: "模型", children: <Models connections={props.connections} models={props.models} busy={busy} mobile={mobile} run={run} /> },
        { key: "tools", label: "工具", children: <Tools /> },
        { key: "general", label: "通用", children: <General settings={props.settings} models={props.models} onSettings={props.onSettings} uiPreferences={props.uiPreferences} onUiPreferences={props.onUiPreferences} /> }
      ]}
    />
  </Drawer>;
}

function Agents({ agents, models, settings, busy, mobile, run }: {
  agents: AgentSummaryDto[];
  models: ModelDto[];
  settings: AppSettings;
  busy: boolean;
  mobile: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(agents[0]?.id ?? null);
  const [detail, setDetail] = useState<AgentDto | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setDetail(null);
    if (editing && editing !== "new") {
      void api.agent(editing).then((agent) => {
        if (active) setDetail(agent);
      }).catch(() => {
        if (active) setDetail(null);
      });
    }
    return () => { active = false; };
  }, [editing, agents]);
  const importFile = async (file: File) => {
    let created: AgentDto | undefined;
    const ok = await run(async () => {
      created = await api.importAgent(file.name, await fileBase64(file));
    }, "Agent 已导入");
    if (ok && created) setEditing(created.id);
  };
  const list = <Flex vertical className="resource-pane" gap="small">
    <Menu
      className="resource-menu"
      selectable
      selectedKeys={editing && editing !== "new" ? [editing] : []}
      items={agents.map((agent) => ({
        key: agent.id,
        label: <Flex vertical><Text>{agent.name}</Text><Text type="secondary" ellipsis>{agent.description || "未填写描述"}</Text></Flex>
      }))}
      onSelect={({ key }) => setEditing(key)}
    />
    <Space.Compact block>
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setEditing("new")}>新建</Button>
      <Tooltip title="导入 JSON 或 PNG"><Button type="dashed" icon={<ImportOutlined />} onClick={() => importRef.current?.click()} /></Tooltip>
    </Space.Compact>
    <input ref={importRef} hidden type="file" accept="application/json,image/png,.json,.png" onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void importFile(file);
      event.currentTarget.value = "";
    }} />
  </Flex>;
  const editor = editing ? <AgentEditor
    key={editing}
    value={editing === "new" ? "new" : detail}
    {...(agents.find((agent) => agent.id === settings.defaultAgentId) ?? agents[0]
      ? { fallback: agents.find((agent) => agent.id === settings.defaultAgentId) ?? agents[0]! }
      : {})}
    models={models}
    busy={busy}
    run={run}
    onDone={(id) => setEditing(id)}
  /> : <Flex className="editor-empty" align="center" justify="center"><Text type="secondary">选择一个 Agent 查看详情</Text></Flex>;
  if (mobile && editing) return <Flex className="settings-mobile-detail" vertical gap="middle">
    <Button className="settings-back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => setEditing(null)}>Agent 列表</Button>
    <div className="settings-editor">{editor}</div>
  </Flex>;
  return <Flex className={mobile ? "settings-mobile-list" : "settings-split"} vertical={mobile} gap="large">
    {list}
    {!mobile && <div className="settings-editor">{editor}</div>}
  </Flex>;
}

function AgentEditor({ value, fallback, models, busy, run, onDone }: {
  value: AgentDto | "new" | null;
  fallback?: AgentSummaryDto;
  models: ModelDto[];
  busy: boolean;
  run: Run;
  onDone: (id: string | null) => void;
}) {
  const existing = value === "new" ? null : value;
  const [form] = Form.useForm<AgentForm>();
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [avatar, setAvatar] = useState<File | null>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const { modal } = AntApp.useApp();
  useEffect(() => {
    void api.toolCatalog().then((next) => {
      setCatalog(next);
      const source = value === "new" ? newAgent(fallback) : value;
      if (source) form.setFieldValue("enabledTools", agentForm(source, next).enabledTools);
    });
  }, []);
  if (value === null) return <Flex justify="center"><Text type="secondary">正在加载 Agent</Text></Flex>;
  const base = existing ?? newAgent(fallback);
  const initial = agentForm(base, catalog);
  const save = async (values: AgentForm) => {
    let saved: AgentDto | undefined;
    const ok = await run(async () => {
      const input = agentInput(values, base, catalog);
      saved = existing ? await api.updateAgent(existing.id, input) : await api.createAgent(input);
      if (avatar && saved) await api.updateAgentAvatar(saved.id, avatar.name, await fileBase64(avatar));
    }, existing ? "Agent 已更新" : "Agent 已创建");
    if (ok && saved) onDone(saved.id);
  };
  return <>
    <Flex justify="space-between" align="center" gap="small" wrap>
      <Title level={5}>{existing?.name ?? "新建 Agent"}</Title>
      {existing && <Space.Compact>
        <Tooltip title="导出 JSON"><Button icon={<DownloadOutlined />} href={api.agentExportUrl(existing.id, "json")} /></Tooltip>
        <Tooltip title="导出 PNG"><Button icon={<DownloadOutlined />} disabled={!existing.hasAvatar} href={api.agentExportUrl(existing.id, "png")} /></Tooltip>
      </Space.Compact>}
    </Flex>
    <Form<AgentForm> form={form} layout="vertical" initialValues={initial} onFinish={(values) => void save(values)}>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="name" label="名称" rules={[{ required: true, whitespace: true }, { max: 200 }]}><Input /></Form.Item>
        <Form.Item className="settings-field" label="头像">
          <Space><Button icon={<UploadOutlined />} onClick={() => avatarRef.current?.click()}>{avatar?.name ?? (existing?.hasAvatar ? "替换 PNG" : "选择 PNG")}</Button>
          {existing?.hasAvatar && <Button danger icon={<DeleteOutlined />} onClick={() => void run(() => api.deleteAgentAvatar(existing.id), "头像已删除")} />}</Space>
          <input ref={avatarRef} hidden type="file" accept="image/png" onChange={(event) => setAvatar(event.target.files?.[0] ?? null)} />
        </Form.Item>
      </Flex>
      <Form.Item name="description" label="描述"><TextArea rows={4} /></Form.Item>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="personality" label="性格"><TextArea rows={4} /></Form.Item>
        <Form.Item className="settings-field" name="scenario" label="场景"><TextArea rows={4} /></Form.Item>
      </Flex>
      <Form.Item name="firstMessage" label="首条开场白"><TextArea rows={4} /></Form.Item>
      <Form.Item name="alternateGreetings" label="备用开场白（JSON 字符串数组）" rules={[jsonRule("必须是 JSON 字符串数组")]}><TextArea rows={4} /></Form.Item>
      <Collapse ghost items={[
        { key: "prompt", label: "提示词与示例", children: <>
          <Form.Item name="systemPrompt" label="系统提示词"><TextArea rows={6} /></Form.Item>
          <Form.Item name="postHistoryInstructions" label="历史后指令"><TextArea rows={4} /></Form.Item>
          <Form.Item name="messageExample" label="对话示例"><TextArea rows={6} /></Form.Item>
        </> },
        { key: "book", label: "Lorebook", children: <Form.Item name="characterBook" label="Character Book JSON" rules={[jsonRule("Lorebook 必须是有效 JSON")] }><TextArea rows={10} /></Form.Item> },
        { key: "metadata", label: "角色卡元数据", children: <>
          <Form.Item name="creatorNotes" label="创作者备注"><TextArea rows={4} /></Form.Item>
          <Flex className="settings-fields-row" gap="middle" wrap>
            <Form.Item className="settings-field" name="creator" label="创作者"><Input /></Form.Item>
            <Form.Item className="settings-field" name="characterVersion" label="角色版本"><Input /></Form.Item>
          </Flex>
          <Form.Item name="tags" label="标签（逗号分隔）"><Input /></Form.Item>
          <Form.Item name="extensions" label="Extensions JSON" rules={[jsonRule("Extensions 必须是有效 JSON 对象")]}><TextArea rows={6} /></Form.Item>
        </> }
      ]} />
      <Title level={5}>执行配置</Title>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="modelId" label="模型"><Select allowClear placeholder="未选择" options={models.filter((model) => model.enabled).map((model) => ({ label: model.displayName, value: model.id }))} /></Form.Item>
        <Form.Item className="settings-field" name="contextPolicy" label="上下文策略"><Select options={[{ label: "自动裁剪", value: "trim" }, { label: "自动摘要", value: "summarize" }, { label: "完整历史", value: "full" }]} /></Form.Item>
        <Form.Item className="settings-field" name="reasoningEffort" label="推理强度"><Select options={["none", "low", "medium", "high", "xhigh", "max"].map((item) => ({ label: item, value: item }))} /></Form.Item>
      </Flex>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="temperature" label="Temperature"><OptionalNumber min={0} max={2} step={0.1} /></Form.Item>
        <Form.Item className="settings-field" name="topP" label="Top P"><OptionalNumber min={0} max={1} step={0.05} /></Form.Item>
        <Form.Item className="settings-field" name="maxOutputTokens" label="最大输出"><InputNumber className="settings-number-input" min={1} max={1_000_000} /></Form.Item>
      </Flex>
      <Form.Item name="stopSequences" label="停止序列（每行一个）"><StopSequencesInput /></Form.Item>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="reasoningSummary" label="推理摘要"><Select allowClear placeholder="使用模型默认" options={["auto", "concise", "detailed"].map((item) => ({ label: item, value: item }))} /></Form.Item>
        <Form.Item className="settings-field" name="thinkingBudgetTokens" label="Thinking token 预算"><InputNumber className="settings-number-input" min={1024} placeholder="使用模型默认" /></Form.Item>
      </Flex>
      <Form.Item name="toolDefaultEnabled" label="默认启用新工具" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="enabledTools" label="工具"><Checkbox.Group options={catalog.map((tool) => ({ label: tool.label, value: tool.name, disabled: !tool.available }))} /></Form.Item>
      <Title level={5}>用户设定覆盖</Title>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="userDisplayName" label="显示名称"><Input placeholder="使用全局名称" /></Form.Item>
        <Form.Item className="settings-field" name="userDescription" label="用户描述"><TextArea rows={3} placeholder="使用全局描述" /></Form.Item>
      </Flex>
      <Space className="settings-actions" wrap>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy}>保存</Button>
        {existing && <Button danger icon={<DeleteOutlined />} disabled={existing.protected || busy} onClick={() => modal.confirm({
          title: "删除 Agent", content: `删除“${existing.name}”？引用它的会话会保留，但发送前需要重新选择 Agent。`, okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
          onOk: async () => { if (await run(() => api.deleteAgent(existing.id), "Agent 已删除")) onDone(null); }
        })}>删除</Button>}
      </Space>
    </Form>
  </>;
}

interface AgentForm {
  name: string; description: string; personality: string; scenario: string; firstMessage: string;
  alternateGreetings: string; systemPrompt: string; postHistoryInstructions: string; messageExample: string;
  characterBook: string; creatorNotes: string; creator: string; characterVersion: string; tags: string; extensions: string;
  modelId?: string | undefined; contextPolicy: AgentInput["execution"]["contextPolicy"];
  reasoningEffort: AgentInput["execution"]["reasoningEffort"];
  temperature?: number | null | undefined; topP?: number | null | undefined; maxOutputTokens?: number | null | undefined; stopSequences?: string[] | undefined;
  reasoningSummary?: "auto" | "concise" | "detailed" | undefined; thinkingBudgetTokens?: number | null | undefined;
  toolDefaultEnabled: boolean; enabledTools: string[]; userDisplayName?: string | undefined; userDescription?: string | undefined;
}

function newAgent(fallback?: AgentSummaryDto): AgentDto {
  const now = Date.now();
  return {
    id: "new", name: "", description: "", protected: false, revision: 1, hasAvatar: false,
    modelId: fallback?.execution.modelId ?? null,
    firstMessage: "你好，{{user}}。", alternateGreetings: [], createdAt: now, updatedAt: now,
    card: { spec: "chara_card_v2", spec_version: "2.0", data: {
      name: "", description: "", personality: "", scenario: "", first_mes: "你好，{{user}}。", mes_example: "",
      creator_notes: "", system_prompt: "{{original}}", post_history_instructions: "", alternate_greetings: [],
      tags: [], creator: "", character_version: "", extensions: {}
    } },
    execution: fallback?.execution ?? { modelId: null, contextPolicy: "trim", reasoningEffort: "none", generation: {}, tools: { defaultEnabled: true, overrides: {} } },
    userProfile: {}
  };
}

function agentForm(agent: AgentDto, catalog: ToolCatalogItemDto[]): AgentForm {
  const data = agent.card.data;
  const policy = agent.execution.tools;
  return {
    name: data.name, description: data.description, personality: data.personality, scenario: data.scenario,
    firstMessage: data.first_mes, alternateGreetings: JSON.stringify(data.alternate_greetings, null, 2),
    systemPrompt: data.system_prompt, postHistoryInstructions: data.post_history_instructions, messageExample: data.mes_example,
    characterBook: data.character_book ? JSON.stringify(data.character_book, null, 2) : "",
    creatorNotes: data.creator_notes, creator: data.creator, characterVersion: data.character_version,
    tags: data.tags.join(", "), extensions: JSON.stringify(data.extensions, null, 2), modelId: agent.execution.modelId ?? undefined,
    contextPolicy: agent.execution.contextPolicy, reasoningEffort: agent.execution.reasoningEffort,
    temperature: agent.execution.generation.common?.temperature, topP: agent.execution.generation.common?.topP,
    maxOutputTokens: agent.execution.generation.common?.maxOutputTokens, stopSequences: agent.execution.generation.common?.stopSequences,
    reasoningSummary: agent.execution.generation.protocol?.reasoningSummary,
    thinkingBudgetTokens: agent.execution.generation.protocol?.thinkingBudgetTokens,
    toolDefaultEnabled: policy.defaultEnabled,
    enabledTools: catalog.filter((tool) => policy.overrides[tool.name] ?? policy.defaultEnabled).map((tool) => tool.name),
    userDisplayName: agent.userProfile.displayName, userDescription: agent.userProfile.description
  };
}

function agentInput(values: AgentForm, base: AgentDto, catalog: ToolCatalogItemDto[]): AgentInput {
  const common = {
    ...(values.temperature !== undefined && values.temperature !== null ? { temperature: values.temperature } : {}),
    ...(values.topP !== undefined && values.topP !== null ? { topP: values.topP } : {}),
    ...(values.maxOutputTokens ? { maxOutputTokens: values.maxOutputTokens } : {}),
    ...(values.stopSequences?.length ? { stopSequences: values.stopSequences } : {})
  };
  const enabled = new Set(values.enabledTools ?? []);
  const overrides = { ...base.execution.tools.overrides };
  for (const tool of catalog) overrides[tool.name] = values.toolDefaultEnabled ? !enabled.has(tool.name) ? false : true : enabled.has(tool.name);
  return {
    card: { ...base.card, data: { ...base.card.data,
      name: values.name.trim(), description: values.description ?? "", personality: values.personality ?? "", scenario: values.scenario ?? "",
      first_mes: values.firstMessage ?? "", alternate_greetings: parseJson(values.alternateGreetings, []),
      system_prompt: values.systemPrompt ?? "", post_history_instructions: values.postHistoryInstructions ?? "",
      mes_example: values.messageExample ?? "", character_book: values.characterBook.trim() ? parseJson(values.characterBook, undefined) : undefined,
      creator_notes: values.creatorNotes ?? "", creator: values.creator ?? "", character_version: values.characterVersion ?? "",
      tags: (values.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean), extensions: parseJson(values.extensions, {})
    } },
    execution: { ...base.execution, modelId: values.modelId ?? null, contextPolicy: values.contextPolicy,
      reasoningEffort: values.reasoningEffort, generation: { ...base.execution.generation, common, protocol: {
        ...(values.reasoningSummary ? { reasoningSummary: values.reasoningSummary } : {}),
        ...(values.thinkingBudgetTokens ? { thinkingBudgetTokens: values.thinkingBudgetTokens } : {})
      } },
      tools: { defaultEnabled: values.toolDefaultEnabled, overrides }
    },
    userProfile: { ...(values.userDisplayName?.trim() ? { displayName: values.userDisplayName.trim() } : {}), ...(values.userDescription?.trim() ? { description: values.userDescription.trim() } : {}) }
  };
}

function jsonRule(message: string) {
  return { validator: async (_: unknown, value: string) => { if (!value?.trim()) return; try { JSON.parse(value); } catch { throw new Error(message); } } };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function Tools() {
  const [settings, setSettings] = useState<ToolSettingsDto | null>(null);
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [saving, setSaving] = useState(false);
  const { message } = AntApp.useApp();
  const load = async () => {
    const [nextSettings, nextCatalog] = await Promise.all([api.toolSettings(), api.toolCatalog()]);
    setSettings(nextSettings);
    setCatalog(nextCatalog);
  };
  useEffect(() => { void load().catch((error) => void message.error(error instanceof Error ? error.message : "工具设置加载失败")); }, []);
  if (!settings) return <Flex justify="center"><Text type="secondary">正在加载工具设置</Text></Flex>;

  const update = async (patch: Parameters<typeof api.updateToolSettings>[0], success?: string) => {
    setSaving(true);
    try {
      const next = await api.updateToolSettings(patch);
      setSettings(next);
      const nextCatalog = await api.toolCatalog();
      setCatalog(nextCatalog);
      if (success) void message.success(success);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return <Flex vertical gap="large" className="general-settings">
    <div>
      <Title level={5}>内置工具</Title>
      <List
        dataSource={catalog}
        renderItem={(item) => <List.Item
          actions={[<Switch
            key="enabled"
            checked={settings.enabled[item.name] !== false}
            disabled={saving || !item.available}
            onChange={(enabled) => void update({ enabled: { ...settings.enabled, [item.name]: enabled } })}
          />]}
        >
          <List.Item.Meta
            avatar={<ApiOutlined />}
            title={<Flex align="center" gap="small"><Text>{item.label}</Text>{item.requiresApproval && <Text type="warning">需审批</Text>}</Flex>}
            description={item.available ? item.description : `${item.description}（尚未配置）`}
          />
        </List.Item>}
      />
    </div>
    <Form
      layout="vertical"
      initialValues={{ searchBaseUrl: settings.search.baseUrl, searchApiKey: "", workspaceShellEnabled: settings.workspaceShellEnabled }}
      onFinish={(values: ToolSettingsForm) => void update({
        search: { baseUrl: values.searchBaseUrl ?? "", ...(values.searchApiKey ? { apiKey: values.searchApiKey } : {}) },
        workspaceShellEnabled: values.workspaceShellEnabled
      }, "工具设置已保存")}
    >
      <Title level={5}>服务端配置</Title>
      <Form.Item name="searchBaseUrl" label="SearXNG 地址" rules={[{ type: "url", warningOnly: true }]}>
        <Input placeholder="https://search.example.com/search" />
      </Form.Item>
      <Form.Item name="searchApiKey" label="搜索服务密钥">
        <Input.Password autoComplete="off" placeholder={settings.search.hasApiKey ? "已保存；留空则不修改" : "可选"} />
      </Form.Item>
      <Form.Item name="workspaceShellEnabled" label="工作区 Shell" valuePropName="checked" extra="启用后每条命令仍需在消息中批准。">
        <Switch />
      </Form.Item>
      <Text type="secondary">工作区：{settings.workspacePath}</Text><br />
      <Text type="secondary">Skills：{settings.skillsPath}</Text>
      <div className="settings-actions"><Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>保存</Button></div>
    </Form>
    <McpSettings />
  </Flex>;
}

interface ToolSettingsForm {
  searchBaseUrl?: string;
  searchApiKey?: string;
  workspaceShellEnabled: boolean;
}

function McpSettings() {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<McpServerForm>();
  const { message, modal } = AntApp.useApp();
  const load = async () => setServers(await api.mcpServers());
  useEffect(() => { void load().catch((error) => void message.error(error instanceof Error ? error.message : "MCP 加载失败")); }, []);
  const act = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      await load();
      void message.success(success);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "MCP 操作失败");
    } finally {
      setBusy(false);
    }
  };
  const create = async (values: McpServerForm) => {
    const input: McpServerInput = {
      name: values.name,
      url: values.url,
      headers: parseHeaders(values.headers ?? ""),
      enabled: true
    };
    await act(() => api.createMcpServer(input), "MCP 服务已添加");
    form.resetFields();
  };
  return <div>
    <Title level={5}>MCP 服务</Title>
    <List
      locale={{ emptyText: "尚未添加 MCP 服务" }}
      dataSource={servers}
      renderItem={(server) => <List.Item actions={[
        <Tooltip key="test" title="测试连接"><Button type="text" icon={<ThunderboltOutlined />} disabled={busy || !server.enabled} onClick={() => void act(() => api.testMcpServer(server.id), "MCP 连接可用")} /></Tooltip>,
        <Switch key="enabled" checked={server.enabled} disabled={busy} onChange={(enabled) => void act(() => api.updateMcpServer(server.id, { enabled }), enabled ? "MCP 已启用" : "MCP 已停用")} />,
        <Tooltip key="delete" title="删除"><Button type="text" danger icon={<DeleteOutlined />} disabled={busy} onClick={() => modal.confirm({
          title: "删除 MCP 服务", content: `删除“${server.name}”？`, okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
          onOk: () => act(() => api.deleteMcpServer(server.id), "MCP 服务已删除")
        })} /></Tooltip>
      ]}>
        <List.Item.Meta
          avatar={<ApiOutlined />}
          title={server.name}
          description={<Flex vertical><Text type="secondary" ellipsis>{server.url}</Text>{server.lastError && <Text type="danger">{server.lastError}</Text>}</Flex>}
        />
      </List.Item>}
    />
    <Form form={form} layout="vertical" onFinish={(values) => void create(values)}>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="name" label="名称" rules={[{ required: true }, { pattern: /^[A-Za-z0-9]+$/, message: "只允许英文字母和数字" }]}>
          <Input placeholder="filesystem" />
        </Form.Item>
        <Form.Item className="settings-field" name="url" label="Streamable HTTP / SSE 地址" rules={[{ required: true }, { type: "url" }]}>
          <Input placeholder="https://example.com/mcp" />
        </Form.Item>
      </Flex>
      <Form.Item name="headers" label="秘密请求头" extra="每行一个，例如 Authorization: Bearer token">
        <TextArea rows={2} />
      </Form.Item>
      <Button htmlType="submit" icon={<PlusOutlined />} loading={busy}>添加 MCP</Button>
    </Form>
  </div>;
}

interface McpServerForm {
  name: string;
  url: string;
  headers?: string;
}

function Connections({ connections, busy, mobile, run }: { connections: ConnectionDto[]; busy: boolean; mobile: boolean; run: Run }) {
  const [editing, setEditing] = useState<ConnectionDto | "new" | null>(connections.length ? null : "new");
  if (mobile && editing) return <Flex className="settings-mobile-detail" vertical gap="middle">
    <Button className="settings-back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => setEditing(null)}>
      连接列表
    </Button>
    <div className="settings-editor">
      <ConnectionEditor key={editing === "new" ? "new" : editing.id} value={editing} busy={busy} run={run} onDone={() => setEditing(null)} />
    </div>
  </Flex>;
  return <Flex className={mobile ? "settings-mobile-list" : "settings-split"} vertical={mobile} gap="large">
    <Flex vertical className="resource-pane" gap="small">
      <Menu
        className="resource-menu"
        selectable
        selectedKeys={editing && editing !== "new" ? [editing.id] : []}
        items={connections.map((connection) => ({
          key: connection.id,
          label: <Flex vertical><Text>{connection.name}</Text><Text type="secondary">{protocolName(connection.protocol)}</Text></Flex>
        }))}
        onSelect={({ key }) => setEditing(connections.find((connection) => connection.id === key) ?? null)}
      />
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setEditing("new")}>新建连接</Button>
    </Flex>
    {!mobile && <div className="settings-editor">
      {editing ? <ConnectionEditor key={editing === "new" ? "new" : editing.id} value={editing} busy={busy} run={run} onDone={() => setEditing(null)} />
        : <Flex className="editor-empty" align="center" justify="center"><Text type="secondary">选择一个连接查看详情</Text></Flex>}
    </div>}
  </Flex>;
}

function ConnectionEditor({ value, busy, run, onDone }: { value: ConnectionDto | "new"; busy: boolean; run: Run; onDone: () => void }) {
  const existing = value === "new" ? null : value;
  const [form] = Form.useForm<ConnectionForm>();
  const { modal } = AntApp.useApp();
  const save = async (values: ConnectionForm) => {
    const input: ConnectionInput = {
      name: values.name,
      protocol: values.protocol,
      baseUrl: values.baseUrl,
      ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      secretHeaders: parseHeaders(values.secretHeaders ?? "")
    };
    const ok = await run(
      () => existing ? api.updateConnection(existing.id, input) : api.createConnection(input),
      existing ? "连接已更新" : "连接已创建"
    );
    if (ok) onDone();
  };
  return <>
    <Title level={5}>{existing ? existing.name : "新建连接"}</Title>
    <Form
      className="settings-form"
      form={form}
      layout="vertical"
      initialValues={{ protocol: existing?.protocol ?? "openai-responses", name: existing?.name ?? "", baseUrl: existing?.baseUrl ?? defaults["openai-responses"], apiKey: "", secretHeaders: "" }}
      onFinish={(values) => void save(values)}
    >
      <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
        <Select options={[
          { label: "OpenAI Responses", value: "openai-responses" },
          { label: "OpenAI Chat Completions", value: "openai-chat" },
          { label: "Anthropic Messages", value: "anthropic-messages" }
        ]} onChange={(protocol: ProviderProtocol) => !existing && form.setFieldValue("baseUrl", defaults[protocol])} />
      </Form.Item>
      <Form.Item name="name" label="连接名称" rules={[{ required: true, whitespace: true }, { max: 80 }]}><Input /></Form.Item>
      <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input /></Form.Item>
      <Form.Item name="apiKey" label="API Key"><Input.Password autoComplete="off" placeholder={existing?.hasApiKey ? "已保存；留空则不修改" : "可选"} /></Form.Item>
      <Form.Item name="secretHeaders" label="秘密请求头" extra="每行一个，例如 X-Org: value"><TextArea rows={3} /></Form.Item>
      <Space className="settings-actions" wrap>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy}>保存</Button>
        {existing && <Button icon={<ThunderboltOutlined />} disabled={busy} onClick={() => void run(() => api.testConnection(existing.id), "连接可用")}>测试</Button>}
        {existing && <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => void run(() => api.discoverModels(existing.id), "模型列表已刷新")}>发现模型</Button>}
        {existing && <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={() => modal.confirm({
          title: "删除连接",
          content: `删除连接“${existing.name}”及其模型？历史回复仍会保留快照。`,
          okText: "删除",
          cancelText: "取消",
          okButtonProps: { danger: true },
          onOk: async () => { if (await run(() => api.deleteConnection(existing.id), "连接已删除")) onDone(); }
        })}>删除</Button>}
      </Space>
    </Form>
  </>;
}

function Models({ connections, models, busy, mobile, run }: { connections: ConnectionDto[]; models: ModelDto[]; busy: boolean; mobile: boolean; run: Run }) {
  const [editing, setEditing] = useState<ModelDto | "new" | null>(models.length ? null : "new");
  if (mobile && editing) return <Flex className="settings-mobile-detail" vertical gap="middle">
    <Button className="settings-back-button" type="text" icon={<ArrowLeftOutlined />} onClick={() => setEditing(null)}>
      模型列表
    </Button>
    <div className="settings-editor">
      <ModelEditor key={editing === "new" ? "new" : editing.id} value={editing} connections={connections} busy={busy} run={run} onDone={() => setEditing(null)} />
    </div>
  </Flex>;
  return <Flex className={mobile ? "settings-mobile-list" : "settings-split"} vertical={mobile} gap="large">
    <Flex vertical className="resource-pane" gap="small">
      <Menu
        className="resource-menu"
        selectable
        selectedKeys={editing && editing !== "new" ? [editing.id] : []}
        items={models.map((model) => ({
          key: model.id,
          label: <Flex vertical><Text>{model.displayName}</Text><Text type="secondary">{connections.find((connection) => connection.id === model.connectionId)?.name ?? "连接已删除"}</Text></Flex>
        }))}
        onSelect={({ key }) => setEditing(models.find((model) => model.id === key) ?? null)}
      />
      <Button type="dashed" block icon={<PlusOutlined />} disabled={!connections.length} onClick={() => setEditing("new")}>手工添加</Button>
    </Flex>
    {!mobile && <div className="settings-editor">
      {editing ? <ModelEditor key={editing === "new" ? "new" : editing.id} value={editing} connections={connections} busy={busy} run={run} onDone={() => setEditing(null)} />
        : <Flex className="editor-empty" align="center" justify="center"><Text type="secondary">选择一个模型配置能力</Text></Flex>}
    </div>}
  </Flex>;
}

function ModelEditor({ value, connections, busy, run, onDone }: { value: ModelDto | "new"; connections: ConnectionDto[]; busy: boolean; run: Run; onDone: () => void }) {
  const existing = value === "new" ? null : value;
  const [form] = Form.useForm<ModelForm>();
  const { modal } = AntApp.useApp();
  const connectionId = Form.useWatch("connectionId", form) as string | undefined;
  const initialConnectionId = existing?.connectionId ?? connections[0]?.id;
  const protocol = connections.find((connection) => connection.id === (connectionId ?? initialConnectionId))?.protocol;
  const capabilities = existing?.capabilities ?? defaultCapabilities(protocol);
  const defaults = existing?.defaultSettings ?? {
    common: { maxOutputTokens: 4096, stopSequences: [] },
    protocol: {}
  } satisfies ModelSettings;
  const save = async (values: ModelForm) => {
    // Trust the submitted form values, not the closure-captured defaults.
    const current = values.capabilities;
    const summarySupported = protocol === "openai-responses" && current.reasoningSummary;
    const budgetSupported = protocol === "anthropic-messages" && current.manualThinking && !current.adaptiveThinking;
    const defaultSettings: ModelSettings = {
      common: {
        maxOutputTokens: Math.min(values.defaultMaxOutputTokens, values.maxOutputTokens),
        stopSequences: values.stopSequences ?? [],
        ...(current.temperature && values.temperature !== undefined && values.temperature !== null ? { temperature: values.temperature } : {}),
        ...(current.topP && values.topP !== undefined && values.topP !== null ? { topP: values.topP } : {})
      },
      protocol: {
        ...(summarySupported ? { reasoningSummary: values.reasoningSummary ?? "auto" } : {}),
        ...(budgetSupported && values.thinkingBudgetTokens ? { thinkingBudgetTokens: Math.min(values.thinkingBudgetTokens, values.defaultMaxOutputTokens - 1) } : {})
      }
    };
    const input: ModelInput = {
      connectionId: values.connectionId,
      modelKey: values.modelKey,
      displayName: values.displayName || values.modelKey,
      contextWindow: values.contextWindow ?? null,
      maxOutputTokens: values.maxOutputTokens,
      capabilities: values.capabilities,
      defaultSettings,
      enabled: values.enabled
    };
    const ok = await run(() => existing ? api.updateModel(existing.id, input) : api.createModel(input), existing ? "模型已更新" : "模型已添加");
    if (ok) onDone();
  };
  return <>
    <Title level={5}>{existing ? existing.displayName : "手工添加模型"}</Title>
    <Form<ModelForm>
      className="settings-form"
      form={form}
      layout="vertical"
      initialValues={{
        connectionId: initialConnectionId,
        modelKey: existing?.modelKey ?? "",
        displayName: existing?.displayName ?? "",
        contextWindow: existing?.contextWindow,
        maxOutputTokens: existing?.maxOutputTokens ?? 4096,
        capabilities,
        enabled: existing?.enabled ?? true,
        defaultMaxOutputTokens: Math.min(defaults.common.maxOutputTokens, existing?.maxOutputTokens ?? 4096),
        temperature: defaults.common.temperature,
        topP: defaults.common.topP,
        stopSequences: defaults.common.stopSequences,
        reasoningSummary: defaults.protocol.reasoningSummary ?? (capabilities.reasoningSummary ? "auto" : undefined),
        thinkingBudgetTokens: defaults.protocol.thinkingBudgetTokens
      }}
      onFinish={(values) => void save(values)}
    >
      <Form.Item name="connectionId" label="连接" rules={[{ required: true }]}><Select disabled={Boolean(existing)} options={connections.map((connection) => ({ label: connection.name, value: connection.id }))} /></Form.Item>
      <Form.Item name="modelKey" label="模型 ID" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
      <Form.Item name="displayName" label="显示名称" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
      <Flex className="settings-fields-row" gap="middle" wrap>
        <Form.Item className="settings-field" name="contextWindow" label="上下文窗口"><InputNumber className="settings-number-input" min={256} placeholder="裁剪/摘要必填" /></Form.Item>
        <Form.Item className="settings-field" name="maxOutputTokens" label="模型上限输出" rules={[{ required: true }]}><InputNumber className="settings-number-input" min={1} /></Form.Item>
      </Flex>
      <Title level={5}>能力</Title>
      <Flex vertical>
        {capabilityEntries.map(([key, label]) => <Form.Item key={key} name={["capabilities", key]} valuePropName="checked"><Checkbox>{label}</Checkbox></Form.Item>)}
      </Flex>
      <Form.Item shouldUpdate={(previous, current) => previous.capabilities !== current.capabilities || previous.defaultMaxOutputTokens !== current.defaultMaxOutputTokens || previous.maxOutputTokens !== current.maxOutputTokens} noStyle>
        {({ getFieldValue }) => {
          const watched = getFieldValue("capabilities") as ModelCapabilities | undefined;
          const shown = watched ?? capabilities;
          const modelMax = (getFieldValue("maxOutputTokens") as number | undefined) ?? existing?.maxOutputTokens ?? 4096;
          const defaultMax = (getFieldValue("defaultMaxOutputTokens") as number | undefined) ?? Math.min(defaults.common.maxOutputTokens, modelMax);
          const showTemperature = shown.temperature;
          const showTopP = shown.topP;
          const showSummary = protocol === "openai-responses" && shown.reasoningSummary;
          const showBudget = protocol === "anthropic-messages" && shown.manualThinking && !shown.adaptiveThinking;
          return <>
            <Title level={5}>默认设置</Title>
            <Flex className="settings-fields-row" gap="middle" wrap>
              <Form.Item
                className="settings-field"
                name="defaultMaxOutputTokens"
                label="默认最大输出 tokens"
                rules={[
                  { required: true },
                  { validator: (_, v: number) => v > modelMax ? Promise.reject(new Error(`不能超过模型上限 ${modelMax}`)) : Promise.resolve() }
                ]}
              ><InputNumber className="settings-number-input" min={1} max={modelMax} /></Form.Item>
              {showSummary ? <Form.Item className="settings-field" name="reasoningSummary" label={<Space size={4}>推理摘要<Tooltip title="供应商返回的可展示推理摘要，不是模型内部思维链。"><QuestionCircleOutlined /></Tooltip></Space>}><Select options={reasoningSummaryOptions} /></Form.Item> : null}
              {showBudget ? <Form.Item className="settings-field" name="thinkingBudgetTokens" label="Thinking 预算 tokens" rules={[{ required: true }]}><InputNumber className="settings-number-input" min={1024} max={Math.max(1024, defaultMax - 1)} /></Form.Item> : null}
            </Flex>
            {showTemperature ? <Form.Item name="temperature" label="默认 Temperature（留空由服务端决定）"><OptionalNumber min={0} max={2} step={0.1} /></Form.Item> : null}
            {showTopP ? <Form.Item name="topP" label="默认 Top P（留空由服务端决定）"><OptionalNumber min={0} max={1} step={0.05} /></Form.Item> : null}
            <Form.Item name="stopSequences" label="停止序列" extra="每行一个，最多 8 条">
              <StopSequencesInput />
            </Form.Item>
          </>;
        }}
      </Form.Item>
      <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
      <Space className="settings-actions" wrap>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy}>保存</Button>
        {existing && <Button danger icon={<DeleteOutlined />} disabled={busy} onClick={() => modal.confirm({
          title: "删除模型",
          content: `删除模型“${existing.displayName}”？使用该模型的会话将要求重新选择模型。`,
          okText: "删除",
          cancelText: "取消",
          okButtonProps: { danger: true },
          onOk: async () => { if (await run(() => api.deleteModel(existing.id), "模型已删除")) onDone(); }
        })}>删除</Button>}
      </Space>
    </Form>
  </>;
}

function StopSequencesInput({ value, onChange }: { value?: string[]; onChange?: (value: string[]) => void }) {
  return <TextArea
    rows={3}
    value={(value ?? []).join("\n")}
    onChange={(event) => onChange?.(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8))}
  />;
}

function OptionalNumber({ value, onChange, min, max, step }: { value?: number | null; onChange?: (value: number | null) => void; min: number; max: number; step: number }) {
  return <InputNumber<number>
    className="settings-number-input"
    value={value ?? null}
    min={min}
    max={max}
    step={step}
    precision={String(step).split(".")[1]?.length ?? 0}
    placeholder="留空"
    onChange={(next) => onChange?.(next)}
  />;
}

function General({ settings, models, onSettings, uiPreferences, onUiPreferences }: {
  settings: AppSettings;
  models: ModelDto[];
  onSettings: (settings: AppSettings) => void;
  uiPreferences: UiPreferences;
  onUiPreferences: (preferences: UiPreferences) => void;
}) {
  const { message } = AntApp.useApp();
  const update = async (patch: Partial<AppSettings>) => {
    try { onSettings(await api.updateSettings(patch)); } catch (error) { void message.error(error instanceof Error ? error.message : "操作失败"); }
  };
  return <Form layout="vertical" className="general-settings">
    <Form.Item label="界面主题"><Select value={settings.theme} options={[{ label: "跟随系统", value: "system" }, { label: "浅色", value: "light" }, { label: "深色", value: "dark" }]} onChange={(value) => void update({ theme: value })} /></Form.Item>
    <Form.Item label="推理过程折叠"><Select value={uiPreferences.reasoningCollapsePolicy} options={[
      { label: "始终默认折叠", value: "always-collapsed" },
      { label: "正式回答后折叠", value: "collapse-on-answer" },
      { label: "不自动折叠", value: "never-auto-collapse" }
    ]} onChange={(reasoningCollapsePolicy) => onUiPreferences({ ...uiPreferences, reasoningCollapsePolicy })} /></Form.Item>
    <Title level={5}>全局用户设定</Title>
    <Form.Item label="显示名称"><Input value={settings.userProfile.displayName} onChange={(event) => onSettings({ ...settings, userProfile: { ...settings.userProfile, displayName: event.target.value } })} onBlur={() => void update({ userProfile: settings.userProfile })} /></Form.Item>
    <Form.Item label="用户描述"><TextArea rows={4} value={settings.userProfile.description} onChange={(event) => onSettings({ ...settings, userProfile: { ...settings.userProfile, description: event.target.value } })} onBlur={() => void update({ userProfile: settings.userProfile })} /></Form.Item>
    <Form.Item label="基础系统提示"><TextArea rows={8} value={settings.defaultSystemPrompt} onChange={(event) => onSettings({ ...settings, defaultSystemPrompt: event.target.value })} onBlur={() => void update({ defaultSystemPrompt: settings.defaultSystemPrompt })} /></Form.Item>
  </Form>;
}

interface ConnectionForm {
  protocol: ProviderProtocol;
  name: string;
  baseUrl: string;
  apiKey?: string;
  secretHeaders?: string;
}

interface ModelForm {
  connectionId: string;
  modelKey: string;
  displayName: string;
  contextWindow?: number | null;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  enabled: boolean;
  defaultMaxOutputTokens: number;
  temperature?: number | null;
  topP?: number | null;
  stopSequences?: string[];
  reasoningSummary?: "auto" | "concise" | "detailed";
  thinkingBudgetTokens?: number;
}

const reasoningSummaryOptions: Array<{ label: string; value: "auto" | "concise" | "detailed" }> = [
  { label: "自动", value: "auto" },
  { label: "简洁", value: "concise" },
  { label: "详细", value: "detailed" }
];

const capabilityEntries: Array<[keyof ModelCapabilities, string]> = [
  ["tools", "工具调用"], ["temperature", "Temperature"], ["topP", "Top P"], ["reasoning", "推理"],
  ["reasoningSummary", "推理摘要"], ["adaptiveThinking", "Adaptive Thinking"], ["manualThinking", "手动 Thinking 预算"]
];

function defaultCapabilities(protocol?: ProviderProtocol): ModelCapabilities {
  return {
    tools: true,
    temperature: true,
    topP: true,
    reasoning: protocol !== "openai-chat",
    reasoningSummary: protocol === "openai-responses",
    adaptiveThinking: protocol === "anthropic-messages",
    manualThinking: protocol === "anthropic-messages"
  };
}

function protocolName(value: ProviderProtocol) { return value === "openai-responses" ? "Responses" : value === "openai-chat" ? "Chat Completions" : "Anthropic Messages"; }
function parseHeaders(value: string): Record<string, string> { return Object.fromEntries(value.split("\n").map((line) => line.split(":" as string)).filter((parts) => parts.length >= 2).map(([name, ...rest]) => [name!.trim(), rest.join(":").trim()]).filter(([name]) => name)); }
