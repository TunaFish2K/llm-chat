import type { AgentDto, AppSettings, ConnectionDto, ModelDto, PluginDto, SkillDto } from "@llm-chat/contracts";
import { App as AntApp } from "antd";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents, Connections, General, McpSettings, Models, PluginSettings, SettingsPanel, SkillSettings, ToolServices, agentForm, agentInput } from "./SettingsPanel";

const state = vi.hoisted(() => ({ screens: { md: true, lg: true } as Record<string, boolean> }));
const api = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  agent: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(),
  updateAgentAvatar: vi.fn(), deleteAgentAvatar: vi.fn(), importAgent: vi.fn(),
  agentExportUrl: vi.fn((id: string, format: string) => `/api/agents/${id}/export?format=${format}`),
  createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(), testConnection: vi.fn(), connectionBalance: vi.fn(), discoverModels: vi.fn(),
  createModel: vi.fn(), updateModel: vi.fn(), deleteModel: vi.fn(),
  toolSettings: vi.fn(), updateToolSettings: vi.fn(), toolCatalog: vi.fn(),
  skills: vi.fn(), installSkill: vi.fn(), reloadSkill: vi.fn(),
  plugins: vi.fn(), installPlugin: vi.fn(), reloadPlugin: vi.fn(), unloadPlugin: vi.fn(), deletePlugin: vi.fn(), configurePlugin: vi.fn(),
  mcpServers: vi.fn(), createMcpServer: vi.fn(), updateMcpServer: vi.fn(), deleteMcpServer: vi.fn(), testMcpServer: vi.fn()
}));

vi.mock("./api", () => ({ api }));
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return { ...actual, Grid: { ...actual.Grid, useBreakpoint: () => state.screens } };
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()
  })) });
});

const settings: AppSettings = {
  defaultModelId: "m1", defaultContextPolicy: "trim", theme: "system", defaultSystemPrompt: "system",
  reasoningEffort: "medium", defaultAgentId: "agent1", lastAgentId: "agent1",
  userProfile: { displayName: "用户", description: "" },
  uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer" }, lastWorkspacePath: null
};
const connection: ConnectionDto = {
  id: "c1", name: "Primary", protocol: "openai-responses", baseUrl: "https://api.example.com/v1",
  hasApiKey: true, secretHeaderNames: ["X-Org"], createdAt: 1, updatedAt: 1
};
const anthropicConnection: ConnectionDto = { ...connection, id: "c2", name: "Claude", protocol: "anthropic-messages" };
const model: ModelDto = {
  id: "m1", connectionId: "c1", modelKey: "gpt-one", displayName: "GPT One", contextWindow: 10000,
  maxOutputTokens: 4096, enabled: true, source: "manual", createdAt: 1, updatedAt: 1,
  capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: true, adaptiveThinking: false, manualThinking: false },
  defaultSettings: { common: { maxOutputTokens: 2048, stopSequences: ["END"], temperature: 0.5, topP: 0.9 }, protocol: { reasoningSummary: "concise" } }
};
const agent: AgentDto = {
  id: "agent1", name: "默认助手", description: "通用助手", protected: true, revision: 1, hasAvatar: false,
  modelId: "m1", firstMessage: "你好，{{user}}。", alternateGreetings: [], createdAt: 1, updatedAt: 1,
  card: { spec: "chara_card_v2", spec_version: "2.0", data: {
    name: "默认助手", description: "通用助手", personality: "", scenario: "", first_mes: "你好，{{user}}。",
    mes_example: "", creator_notes: "", system_prompt: "{{original}}", post_history_instructions: "",
    alternate_greetings: [], tags: [], creator: "", character_version: "", extensions: {}
  } },
  execution: { modelId: "m1", contextPolicy: "trim", reasoningEffort: "medium", generation: {}, tools: { defaultEnabled: true, overrides: {}, approvalOverrides: {} }, enabledSkillIds: [], maxToolRounds: 32, maxBackgroundTasks: 2, taskLogLimitBytes: 64 * 1024 * 1024 },
  userProfile: {}
};
const anthropicModel: ModelDto = {
  ...model, id: "m2", connectionId: "c2", modelKey: "claude", displayName: "Claude",
  capabilities: { ...model.capabilities, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
  defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: { thinkingBudgetTokens: 2048 } }
};
const plugin: PluginDto = {
  id: "sample-plugin",
  manifest: {
    id: "sample-plugin", name: "Sample Plugin", version: "1.0.0", apiVersion: 1, entry: "index.js",
    description: "A configurable plugin", configSchema: { type: "object" }, secretFields: ["token"]
  },
  revision: "rev-1", sourcePath: "/plugins/sample", state: "loaded", error: null,
  config: { endpoint: "https://old.example.com" }, configuredSecretFields: ["token"], installedAt: 1, updatedAt: 2
};
const skill: SkillDto = {
  id: "sample-skill", name: "Sample Skill", description: "A test skill", revision: "rev-1",
  sourcePath: "/skills/sample", state: "loaded", error: null, requiredTools: ["web_search"],
  recommendedApprovals: {}, bundled: false, installedAt: 1, updatedAt: 2
};

function resetApis() {
  vi.clearAllMocks();
  api.updateSettings.mockResolvedValue(settings);
  api.agent.mockResolvedValue(agent);
  api.createAgent.mockResolvedValue(agent);
  api.updateAgent.mockResolvedValue(agent);
  api.deleteAgent.mockResolvedValue(undefined);
  api.updateAgentAvatar.mockResolvedValue(agent);
  api.deleteAgentAvatar.mockResolvedValue(undefined);
  api.importAgent.mockResolvedValue(agent);
  api.createConnection.mockResolvedValue(connection);
  api.updateConnection.mockResolvedValue(connection);
  api.deleteConnection.mockResolvedValue(undefined);
  api.testConnection.mockResolvedValue({ ok: true, modelsFound: 1 });
  api.connectionBalance.mockResolvedValue({ connectionId: "c1", value: 1234.56789, fetchedAt: 1, cached: false });
  api.discoverModels.mockResolvedValue({ discovered: 1, created: [] });
  api.createModel.mockResolvedValue(model);
  api.updateModel.mockResolvedValue(model);
  api.deleteModel.mockResolvedValue(undefined);
  api.toolSettings.mockResolvedValue({
    enabled: { web_search: true, workspace_shell: false }, search: { baseUrl: "https://search.example.com", hasApiKey: true },
    workspaceShellEnabled: false, workspacePath: "/workspace", skillsPath: "/skills"
  });
  api.updateToolSettings.mockImplementation(async (patch) => ({
    enabled: patch.enabled ?? { web_search: true }, search: { baseUrl: patch.search?.baseUrl ?? "https://search.example.com", hasApiKey: true },
    workspaceShellEnabled: patch.workspaceShellEnabled ?? false, workspacePath: "/workspace", skillsPath: "/skills"
  }));
  api.toolCatalog.mockResolvedValue([
    { name: "web_search", label: "Web search", description: "Search", category: "web", requiresApproval: false, available: true },
    { name: "workspace_shell", label: "Shell", description: "Run commands", category: "workspace", requiresApproval: true, available: false }
  ]);
  api.skills.mockResolvedValue([]);
  api.installSkill.mockResolvedValue(skill);
  api.reloadSkill.mockResolvedValue(skill);
  api.plugins.mockResolvedValue([]);
  api.installPlugin.mockResolvedValue(plugin);
  api.reloadPlugin.mockResolvedValue(plugin);
  api.unloadPlugin.mockResolvedValue({ ...plugin, state: "unloaded" });
  api.deletePlugin.mockResolvedValue(undefined);
  api.configurePlugin.mockResolvedValue(plugin);
  api.mcpServers.mockResolvedValue([{ id: "s1", name: "Docs", url: "https://mcp.example.com", headerNames: [], enabled: true, lastError: "previous error", createdAt: 1, updatedAt: 1 }]);
  api.createMcpServer.mockResolvedValue({});
  api.updateMcpServer.mockResolvedValue({});
  api.deleteMcpServer.mockResolvedValue(undefined);
  api.testMcpServer.mockResolvedValue({ ok: true, tools: 2, serverName: "Docs" });
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  const props = {
    open: true, settings, connections: [connection, anthropicConnection], models: [model, anthropicModel],
    uiPreferences: settings.uiPreferences, onClose: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined),
    onSettings: vi.fn(), onUiPreferences: vi.fn(), ...overrides
  };
  render(<AntApp><SettingsPanel {...props} /></AntApp>);
  return props;
}

const run = vi.fn(async (action: () => Promise<unknown>, _success: string) => {
  await action();
  return true;
});

function renderAgents(overrides: Partial<React.ComponentProps<typeof Agents>> = {}) {
  render(<AntApp><Agents agents={[agent]} models={[model, anthropicModel]} settings={settings} busy={false} mobile={false} run={run} {...overrides} /></AntApp>);
}

function renderConnections(overrides: Partial<React.ComponentProps<typeof Connections>> = {}) {
  render(<AntApp><Connections connections={[connection, anthropicConnection]} busy={false} mobile={false} run={run} {...overrides} /></AntApp>);
}

function renderModels(overrides: Partial<React.ComponentProps<typeof Models>> = {}) {
  render(<AntApp><Models connections={[connection, anthropicConnection]} models={[model, anthropicModel]} busy={false} mobile={false} run={run} {...overrides} /></AntApp>);
}

function renderGeneral() {
  const props = { onSettings: vi.fn(), onUiPreferences: vi.fn() };
  render(<AntApp><General settings={settings} models={[model, anthropicModel]} uiPreferences={settings.uiPreferences} {...props} /></AntApp>);
  return props;
}

function inputInField(label: string): HTMLInputElement {
  const labelNode = screen.getByText(label, { selector: "label" });
  return labelNode.closest(".ant-form-item")!.querySelector("input")!;
}

async function confirmDelete() {
  await waitFor(() => expect(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary")).toBeTruthy());
  fireEvent.click(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary") as HTMLElement);
}

export function registerSettingsResourceTests() {
  describe("Settings resources", () => {
    beforeEach(() => { state.screens = { md: true, lg: true }; resetApis(); });

  it("requests the selected Agent detail", async () => {
    api.agent.mockReturnValueOnce(new Promise(() => {}));
    renderPanel({ agents: [agent] });
    await waitFor(() => expect(api.agent).toHaveBeenCalledWith("agent1"));
    expect(screen.getByText("正在加载 Agent")).toBeInTheDocument();
  });

  it("allows unavailable Agent tools to be overridden and saves false", async () => {
    const catalog = await api.toolCatalog();
    const values = agentForm(agent, catalog);
    expect(values.enabledTools).toContain("workspace_shell");

    values.enabledTools = values.enabledTools.filter((name) => name !== "workspace_shell");
    const input = agentInput(values, agent, catalog);

    expect(input.execution.tools.overrides.workspace_shell).toBe(false);
  });

  it("imports a character card and selects the imported Agent", async () => {
    const imported = {
      ...agent,
      id: "imported",
      name: "导入角色",
      card: { ...agent.card, data: { ...agent.card.data, name: "导入角色" } }
    };
    api.importAgent.mockResolvedValue(imported);
    api.agent.mockReturnValue(new Promise(() => {}));
    renderAgents({ agents: [] });

    expect(await screen.findByRole("button", { name: /新建 Agent/ })).toBeInTheDocument();
    const importButton = screen.getByRole("button", { name: /导入角色卡/ });
    expect(importButton).toBeInTheDocument();
    const fileInput = document.querySelector('input[type="file"][accept="application/json,image/png,.json,.png"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();
    const file = new File(["{}"], "card.json", { type: "application/json" });
    Object.defineProperty(file, "arrayBuffer", { configurable: true, value: async () => new Uint8Array([123, 125]).buffer });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(api.importAgent).toHaveBeenCalledWith("card.json", "e30="));
    await waitFor(() => expect(api.agent).toHaveBeenCalledWith("imported"));
    expect(screen.getByText("正在加载 Agent")).toBeInTheDocument();
  });

  it("renders desktop connection details, retains secrets, and saves parsed headers", async () => {
    renderConnections();
    expect(screen.getByText("选择一个连接查看详情")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Primary"));
    expect(screen.getByPlaceholderText("已保存；留空则不修改")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "Updated" } });
    fireEvent.change(screen.getByLabelText("秘密请求头"), { target: { value: " X-Org: alpha:beta\ninvalid\n : skip" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalled());
    expect(api.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      name: "Updated", secretHeaders: { "X-Org": "alpha:beta" }
    }));
    expect(api.updateConnection.mock.calls[0]![1]).not.toHaveProperty("apiKey");
    expect(api.updateConnection.mock.calls[0]![1]).not.toHaveProperty("balanceConfig");
    expect(run).toHaveBeenCalled();
  });

  it("creates and validates connections and reports failed actions", async () => {
    renderConnections({ connections: [] });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(api.createConnection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      name: "New", baseUrl: "https://api.openai.com/v1", secretHeaders: {}
    })));
    expect(run).toHaveBeenCalled();
  });

  it("reports a failed connection action", async () => {
    api.testConnection.mockRejectedValueOnce(new Error("connection failed"));
    renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "连接" }));
    fireEvent.click(screen.getByText("Primary"));
    fireEvent.click(screen.getByRole("button", { name: /测试/ }));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledWith("c1"));
  });

  it("tests, discovers, and deletes an existing connection", async () => {
    renderConnections();
    fireEvent.click(screen.getByText("Primary"));
    fireEvent.click(screen.getByRole("button", { name: /测试/ }));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledWith("c1"));
    fireEvent.click(screen.getByRole("button", { name: /发现模型/ }));
    await waitFor(() => expect(api.discoverModels).toHaveBeenCalledWith("c1"));
    const deleteButton = screen.getByRole("button", { name: /删除/ });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);
    expect(await screen.findByText(/删除连接“Primary”/)).toBeInTheDocument();
    await confirmDelete();
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalledWith("c1"));
  });
  });
}

export function registerSettingsDetailTests() {
  describe("Settings details", () => {
    beforeEach(() => { state.screens = { md: true, lg: true }; resetApis(); });
  it("defaults, validates, and serializes an enabled balance configuration", async () => {
    renderConnections({ connections: [] });
    fireEvent.click(screen.getByText("账户余额"));
    fireEvent.click(screen.getByRole("switch", { name: "启用账户余额" }));
    expect(inputInField("余额 API 路径")).toHaveValue("/credits");
    expect(inputInField("数值结果表达式")).toHaveValue("data.total_credits - data.total_usage");

    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "New" } });
    fireEvent.change(inputInField("余额 API 路径"), { target: { value: "//outside" } });
    fireEvent.change(inputInField("数值结果表达式"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(await screen.findByText(/路径必须以一个/)).toBeInTheDocument();
    expect(await screen.findByText("请输入数值结果表达式")).toBeInTheDocument();
    expect(api.createConnection).not.toHaveBeenCalled();

    fireEvent.change(inputInField("余额 API 路径"), { target: { value: "/account/credits" } });
    fireEvent.change(inputInField("数值结果表达式"), { target: { value: " data.credit - data.used " } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      balanceConfig: { enabled: true, apiPath: "/account/credits", resultExpression: "data.credit - data.used" }
    })));
  });

  it("retains balance settings and refresh-tests an existing enabled connection", async () => {
    const configured: ConnectionDto = {
      ...connection,
      balanceConfig: { enabled: true, apiPath: "/wallet", resultExpression: "data.available" }
    };
    renderConnections({ connections: [configured] });
    fireEvent.click(screen.getByText("Primary"));
    expect(inputInField("余额 API 路径")).toHaveValue("/wallet");
    fireEvent.click(screen.getByRole("button", { name: "测试余额" }));
    await waitFor(() => expect(api.connectionBalance).toHaveBeenCalledWith("c1", true));
    expect(await screen.findByText(/账户余额：1,234\.5679/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      balanceConfig: { enabled: true, apiPath: "/wallet", resultExpression: "data.available" }
    })));
    expect(api.updateConnection.mock.calls.at(-1)![1]).not.toHaveProperty("apiKey");
  });

  it("shows capability-driven model fields and serializes an existing model", async () => {
    renderModels();
    fireEvent.click(screen.getByText("GPT One"));
    expect(screen.getAllByText("推理摘要")).toHaveLength(2);
    expect(inputInField("默认 Temperature（留空由服务端决定）")).toHaveValue("0.5");
    expect(inputInField("默认 Top P（留空由服务端决定）")).toHaveValue("0.90");
    const stop = screen.getByText("停止序列", { selector: "label" })
      .closest(".ant-form-item")!
      .querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(stop, { target: { value: " ONE \n TWO \n THREE " } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalled());
    expect(api.updateModel).toHaveBeenCalledWith("m1", expect.objectContaining({
      defaultSettings: expect.objectContaining({
        common: expect.objectContaining({ stopSequences: ["ONE", "TWO", "THREE"], temperature: 0.5, topP: 0.9 }),
        protocol: { reasoningSummary: "concise" }
      })
    }));
  });

  it("creates a manual model with protocol defaults", async () => {
    renderModels({ connections: [connection], models: [] });
    expect(screen.getByRole("heading", { name: "手工添加模型" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "gpt-new" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "GPT New" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.createModel).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "c1",
      modelKey: "gpt-new",
      displayName: "GPT New",
      contextWindow: null,
      capabilities: expect.objectContaining({ reasoning: true, reasoningSummary: true }),
      defaultSettings: expect.objectContaining({
        common: expect.objectContaining({ maxOutputTokens: 4096, stopSequences: [] }),
        protocol: { reasoningSummary: "auto" }
      })
    })));
  });

  it("shows Anthropic thinking budget and supports model deletion", async () => {
    renderModels({ connections: [anthropicConnection], models: [anthropicModel] });
    fireEvent.click(screen.getByRole("menuitem"));
    expect(await screen.findByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(inputInField("Thinking 预算 tokens")).toHaveValue("2048");
    expect(screen.getAllByText("推理摘要")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    await confirmDelete();
    await waitFor(() => expect(api.deleteModel).toHaveBeenCalledWith("m2"));
  });

  it("loads and updates service settings while keeping a blank search secret", async () => {
    render(<AntApp><ToolServices /></AntApp>);
    expect(await screen.findByRole("heading", { name: "服务端配置" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://search.example.com")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /保存/ });
    fireEvent.click(save);
    await waitFor(() => expect(api.updateToolSettings).toHaveBeenLastCalledWith({
      search: { baseUrl: "https://search.example.com" }
    }));
  });

  it("loads and creates MCP servers from the extensions page", async () => {
    render(<AntApp><McpSettings /></AntApp>);
    await waitFor(() => expect(api.mcpServers).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Docs2" } });
    fireEvent.change(screen.getByLabelText("Streamable HTTP / SSE 地址"), { target: { value: "https://new.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("秘密请求头"), { target: { value: "Authorization: Bearer token\nX-Test: a:b" } });
    fireEvent.click(screen.getByRole("button", { name: /添加 MCP/ }));
    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledWith({
      name: "Docs2", url: "https://new.example.com/mcp", headers: { Authorization: "Bearer token", "X-Test": "a:b" }, enabled: true
    }));
  });

  it("manages the full Plugin lifecycle and reports action failures", async () => {
    api.plugins.mockResolvedValue([plugin]);
    render(<AntApp><PluginSettings /></AntApp>);
    expect(await screen.findByText("Sample Plugin")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("插件源目录绝对路径"), { target: { value: " /plugins/new " } });
    fireEvent.click(screen.getByRole("button", { name: /安装/ }));
    await waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith("/plugins/new"));

    fireEvent.click(screen.getByText("配置"));
    fireEvent.change(screen.getByLabelText("Sample Plugin配置 JSON"), { target: { value: '{"endpoint":"https://new.example.com"}' } });
    fireEvent.change(screen.getByPlaceholderText(/秘密 JSON/), { target: { value: '{"token":"secret"}' } });
    fireEvent.click(screen.getByRole("button", { name: /保存配置/ }));
    await waitFor(() => expect(api.configurePlugin).toHaveBeenCalledWith("sample-plugin", { endpoint: "https://new.example.com" }, { token: "secret" }));

    fireEvent.click(document.querySelector(".anticon-reload")!.closest("button")!);
    await waitFor(() => expect(api.reloadPlugin).toHaveBeenCalledWith("sample-plugin"));
    fireEvent.click(document.querySelector(".extension-row .ant-switch") as HTMLElement);
    await waitFor(() => expect(api.unloadPlugin).toHaveBeenCalledWith("sample-plugin"));

    api.reloadPlugin.mockRejectedValueOnce("reload rejected");
    fireEvent.click(document.querySelector(".anticon-reload")!.closest("button")!);
    expect(await screen.findByText("操作失败")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".extension-row .anticon-delete")!.closest("button")!);
    await confirmDelete();
    await waitFor(() => expect(api.deletePlugin).toHaveBeenCalledWith("sample-plugin"));
  });

  it("installs and reloads Skills and displays a reload failure", async () => {
    api.skills.mockResolvedValue([skill]);
    render(<AntApp><SkillSettings /></AntApp>);
    expect(await screen.findByText("Sample Skill")).toBeInTheDocument();
    expect(screen.getByText(/工具 web_search/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Skill 源目录绝对路径"), { target: { value: " /skills/new " } });
    fireEvent.click(screen.getByRole("button", { name: /安装/ }));
    await waitFor(() => expect(api.installSkill).toHaveBeenCalledWith("/skills/new"));

    fireEvent.click(document.querySelector(".anticon-reload")!.closest("button")!);
    await waitFor(() => expect(api.reloadSkill).toHaveBeenCalledWith("sample-skill"));
    api.reloadSkill.mockRejectedValueOnce(new Error("skill reload failed"));
    fireEvent.click(document.querySelector(".anticon-reload")!.closest("button")!);
    expect(await screen.findByText("skill reload failed")).toBeInTheDocument();
  });

  it("tests, disables, and deletes MCP servers while retaining failure feedback", async () => {
    render(<AntApp><McpSettings /></AntApp>);
    expect(await screen.findByText("Docs")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".anticon-thunderbolt")!.closest("button")!);
    await waitFor(() => expect(api.testMcpServer).toHaveBeenCalledWith("s1"));
    fireEvent.click(document.querySelector(".extension-row .ant-switch") as HTMLElement);
    await waitFor(() => expect(api.updateMcpServer).toHaveBeenCalledWith("s1", { enabled: false }));

    api.testMcpServer.mockRejectedValueOnce(new Error("MCP unavailable"));
    fireEvent.click(document.querySelector(".anticon-thunderbolt")!.closest("button")!);
    expect(await screen.findByText("MCP unavailable")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".extension-row .anticon-delete")!.closest("button")!);
    await confirmDelete();
    await waitFor(() => expect(api.deleteMcpServer).toHaveBeenCalledWith("s1"));
  });

  it("updates general settings and rolls API failures into a message", async () => {
    const user = userEvent.setup();
    const props = renderGeneral();
    const prompt = screen.getByText("基础系统提示", { selector: "label" }).closest(".ant-form-item")!.querySelector("textarea")!;
    fireEvent.change(prompt, { target: { value: "changed" } });
    expect(props.onSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultSystemPrompt: "changed" }));
    fireEvent.blur(prompt);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ defaultSystemPrompt: "system" }));
    api.updateSettings.mockRejectedValueOnce("not an error");
    const selects = screen.getAllByRole("combobox");
    await user.click(selects[0]!);
    await user.click(await screen.findByText("深色"));
    expect(await screen.findByText("操作失败")).toBeInTheDocument();
    await user.click(selects[1]!);
    await user.click(await screen.findByText("不自动折叠"));
    expect(props.onUiPreferences).toHaveBeenCalledWith({ sidebarCollapsed: false, reasoningCollapsePolicy: "never-auto-collapse" });
  });

  it("uses mobile connection and model list/detail paths", async () => {
    state.screens = { md: false, lg: false };
    renderConnections({ mobile: true });
    fireEvent.click(screen.getByText("Primary"));
    expect(screen.getByRole("button", { name: /连接列表/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /连接列表/ }));
    expect(screen.getByRole("button", { name: /新建连接/ })).toBeInTheDocument();
    cleanup();
    renderModels({ mobile: true });
    fireEvent.click(screen.getByText("GPT One"));
    expect(screen.getByRole("button", { name: /模型列表/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /模型列表/ }));
    expect(screen.getByRole("button", { name: /手工添加/ })).toBeInTheDocument();
  });
  });
}
