import type { AppSettings, ConnectionDto, ModelDto } from "@llm-chat/contracts";
import { App as AntApp } from "antd";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

const state = vi.hoisted(() => ({ screens: { md: true, lg: true } as Record<string, boolean> }));
const api = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(), testConnection: vi.fn(), discoverModels: vi.fn(),
  createModel: vi.fn(), updateModel: vi.fn(), deleteModel: vi.fn(),
  toolSettings: vi.fn(), updateToolSettings: vi.fn(), toolCatalog: vi.fn(),
  mcpServers: vi.fn(), createMcpServer: vi.fn(), updateMcpServer: vi.fn(), deleteMcpServer: vi.fn(), testMcpServer: vi.fn()
}));

vi.mock("./api", () => ({ api }));
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return { ...actual, Grid: { ...actual.Grid, useBreakpoint: () => state.screens } };
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()
  })) });
});

const settings: AppSettings = {
  defaultModelId: "m1", defaultContextPolicy: "trim", theme: "system", defaultSystemPrompt: "system",
  reasoningEffort: "medium", uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer" }
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
const anthropicModel: ModelDto = {
  ...model, id: "m2", connectionId: "c2", modelKey: "claude", displayName: "Claude",
  capabilities: { ...model.capabilities, reasoningSummary: false, adaptiveThinking: false, manualThinking: true },
  defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: { thinkingBudgetTokens: 2048 } }
};

function resetApis() {
  vi.clearAllMocks();
  api.updateSettings.mockResolvedValue(settings);
  api.createConnection.mockResolvedValue(connection);
  api.updateConnection.mockResolvedValue(connection);
  api.deleteConnection.mockResolvedValue(undefined);
  api.testConnection.mockResolvedValue({ ok: true, modelsFound: 1 });
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

async function selectTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

function inputInField(label: string): HTMLInputElement {
  const labelNode = screen.getByText(label, { selector: "label" });
  return labelNode.closest(".ant-form-item")!.querySelector("input")!;
}

async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary")).toBeTruthy());
  await user.click(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary") as HTMLElement);
}

describe("SettingsPanel", () => {
  beforeEach(() => { state.screens = { md: true, lg: true }; resetApis(); });

  it("renders desktop connection details, retains secrets, and saves parsed headers", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    expect(screen.getByText("模型、连接、工具与界面")).toBeInTheDocument();
    expect(screen.getByText("选择一个连接查看详情")).toBeInTheDocument();
    await user.click(screen.getByText("Primary"));
    expect(screen.getByPlaceholderText("已保存；留空则不修改")).toHaveValue("");
    await user.clear(screen.getByLabelText("连接名称"));
    await user.type(screen.getByLabelText("连接名称"), "Updated");
    await user.type(screen.getByLabelText("秘密请求头"), " X-Org: alpha:beta\ninvalid\n : skip");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.updateConnection).toHaveBeenCalled());
    expect(api.updateConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      name: "Updated", secretHeaders: { "X-Org": "alpha:beta" }
    }));
    expect(api.updateConnection.mock.calls[0]![1]).not.toHaveProperty("apiKey");
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("creates and validates connections and reports failed actions", async () => {
    const user = userEvent.setup();
    const props = renderPanel({ connections: [] });
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(api.createConnection).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("连接名称"), "New");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      name: "New", baseUrl: "https://api.openai.com/v1", secretHeaders: {}
    })));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("reports a failed connection action", async () => {
    const user = userEvent.setup();
    api.testConnection.mockRejectedValueOnce(new Error("connection failed"));
    renderPanel();
    await user.click(screen.getByText("Primary"));
    await user.click(screen.getByRole("button", { name: /测试/ }));
    expect(await screen.findByText("connection failed")).toBeInTheDocument();
  });

  it("tests, discovers, and deletes an existing connection", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByText("Primary"));
    await user.click(screen.getByRole("button", { name: /测试/ }));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledWith("c1"));
    await user.click(screen.getByRole("button", { name: /发现模型/ }));
    await waitFor(() => expect(api.discoverModels).toHaveBeenCalledWith("c1"));
    const deleteButton = screen.getByRole("button", { name: /删除/ });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    await user.click(deleteButton);
    expect(await screen.findByText(/删除连接“Primary”/)).toBeInTheDocument();
    await confirmDelete(user);
    await waitFor(() => expect(api.deleteConnection).toHaveBeenCalledWith("c1"));
  });

  it("shows capability-driven model fields and serializes an existing model", async () => {
    const user = userEvent.setup();
    renderPanel();
    await selectTab("模型");
    await user.click(screen.getByText("GPT One"));
    expect(screen.getAllByText("推理摘要")).toHaveLength(2);
    expect(inputInField("默认 Temperature（留空由服务端决定）")).toHaveValue("0.5");
    expect(inputInField("默认 Top P（留空由服务端决定）")).toHaveValue("0.90");
    const stop = screen.getByText("停止序列", { selector: "label" })
      .closest(".ant-form-item")!
      .querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(stop, { target: { value: " ONE \n TWO \n THREE " } });
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalled());
    expect(api.updateModel).toHaveBeenCalledWith("m1", expect.objectContaining({
      defaultSettings: expect.objectContaining({
        common: expect.objectContaining({ stopSequences: ["ONE", "TWO", "THREE"], temperature: 0.5, topP: 0.9 }),
        protocol: { reasoningSummary: "concise" }
      })
    }));
  });

  it("creates a manual model with protocol defaults", async () => {
    const user = userEvent.setup();
    renderPanel({ connections: [connection], models: [] });
    await selectTab("模型");
    expect(screen.getByRole("heading", { name: "手工添加模型" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("模型 ID"), "gpt-new");
    await user.type(screen.getByLabelText("显示名称"), "GPT New");
    await user.click(screen.getByRole("button", { name: /保存/ }));
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
    const user = userEvent.setup();
    renderPanel({ connections: [anthropicConnection], models: [anthropicModel] });
    await selectTab("模型");
    await user.click(within(screen.getByRole("tabpanel")).getByRole("menuitem"));
    expect(await screen.findByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(inputInField("Thinking 预算 tokens")).toHaveValue("2048");
    expect(screen.getAllByText("推理摘要")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /删除/ }));
    await confirmDelete(user);
    await waitFor(() => expect(api.deleteModel).toHaveBeenCalledWith("m2"));
  });

  it("loads and updates tools while keeping a blank search secret", async () => {
    const user = userEvent.setup();
    renderPanel();
    await selectTab("工具");
    expect(await screen.findByText("Web search")).toBeInTheDocument();
    expect(screen.getByText("Run commands（尚未配置）")).toBeInTheDocument();
    expect(screen.getByText("需审批")).toBeInTheDocument();
    expect(screen.getByText("工作区：/workspace")).toBeInTheDocument();
    const webRow = screen.getByText("Web search").closest(".ant-list-item") as HTMLElement;
    await user.click(within(webRow).getByRole("switch"));
    await waitFor(() => expect(api.updateToolSettings).toHaveBeenCalledWith({ enabled: { web_search: false, workspace_shell: false } }));
    const save = screen.getByRole("button", { name: /保存/ });
    await user.click(save);
    await waitFor(() => expect(api.updateToolSettings).toHaveBeenLastCalledWith({
      search: { baseUrl: "https://search.example.com" }, workspaceShellEnabled: false
    }));
  });

  it("creates, tests, toggles, and deletes MCP servers", async () => {
    renderPanel();
    await selectTab("工具");
    expect(await screen.findByText("Docs")).toBeInTheDocument();
    expect(screen.getByText("previous error")).toBeInTheDocument();
    const serverRow = screen.getByText("Docs").closest(".ant-list-item") as HTMLElement;
    fireEvent.click(within(serverRow).getByRole("button", { name: "thunderbolt" }));
    await waitFor(() => expect(api.testMcpServer).toHaveBeenCalledWith("s1"));
    fireEvent.click(within(serverRow).getByRole("switch"));
    await waitFor(() => expect(api.updateMcpServer).toHaveBeenCalledWith("s1", { enabled: false }));
    fireEvent.click(within(serverRow).getByRole("button", { name: "delete" }));
    await waitFor(() => expect(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary")).toBeTruthy());
    fireEvent.click(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary") as HTMLElement);
    await waitFor(() => expect(api.deleteMcpServer).toHaveBeenCalledWith("s1"));

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Docs2" } });
    fireEvent.change(screen.getByLabelText("Streamable HTTP / SSE 地址"), { target: { value: "https://new.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("秘密请求头"), { target: { value: "Authorization: Bearer token\nX-Test: a:b" } });
    fireEvent.click(screen.getByRole("button", { name: /添加 MCP/ }));
    await waitFor(() => expect(api.createMcpServer).toHaveBeenCalledWith({
      name: "Docs2", url: "https://new.example.com/mcp", headers: { Authorization: "Bearer token", "X-Test": "a:b" }, enabled: true
    }));
  }, 30_000);

  it("updates general settings and rolls API failures into a message", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    await selectTab("通用");
    const prompt = document.querySelector(".general-settings textarea") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "changed" } });
    expect(props.onSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultSystemPrompt: "changed" }));
    fireEvent.blur(prompt);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ defaultSystemPrompt: "system" }));
    api.updateSettings.mockRejectedValueOnce("not an error");
    const selects = screen.getAllByRole("combobox");
    await user.click(selects[2]!);
    await user.click(await screen.findByText("深色"));
    expect(await screen.findByText("操作失败")).toBeInTheDocument();
    await user.click(selects[3]!);
    await user.click(await screen.findByText("不自动折叠"));
    expect(props.onUiPreferences).toHaveBeenCalledWith({ sidebarCollapsed: false, reasoningCollapsePolicy: "never-auto-collapse" });
  });

  it("uses mobile connection and model list/detail paths", async () => {
    const user = userEvent.setup();
    state.screens = { md: false, lg: false };
    renderPanel();
    expect(screen.queryByText("模型、连接、工具与界面")).not.toBeInTheDocument();
    await user.click(screen.getByText("Primary"));
    expect(screen.getByRole("button", { name: /连接列表/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /连接列表/ }));
    expect(screen.getByRole("button", { name: /新建连接/ })).toBeInTheDocument();
    await selectTab("模型");
    await user.click(screen.getByText("GPT One"));
    expect(screen.getByRole("button", { name: /模型列表/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /模型列表/ }));
    expect(screen.getByRole("button", { name: /手工添加/ })).toBeInTheDocument();
  });
});
