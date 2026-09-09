import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { endpoints } from "../lib/api";
import * as pwa from "../lib/pwa";
import { appStore } from "../lib/app-state";
import { SettingsView } from "./SettingsView";
import { makeAgent, makeConnection, makeModel, makeSettings } from "../../test/fixtures";

vi.mock("virtual:pwa-register", () => ({ registerSW: vi.fn() }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SettingsView", () => {
  it("renders the general section with theme control", () => {
    appStore.set({ settings: makeSettings(), agents: [makeAgent()], models: [] });
    render(<SettingsView section="general" />);
    expect(screen.getByLabelText("主题")).toHaveValue("dark");
    expect(screen.queryByLabelText("默认推理档位")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("默认模型")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("默认上下文策略")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("默认系统提示")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "编辑此 Agent" })).toHaveAttribute("href", "/agents/agent-1");
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
  });

  it("requires an explicit click to apply a prepared application update", async () => {
    const snapshot = { ...pwa.getPwaState(), supported: true, updateAvailable: true, updateStatus: "ready" as const };
    vi.spyOn(pwa, "getPwaState").mockReturnValue(snapshot);
    const apply = vi.spyOn(pwa, "applyUpdate").mockResolvedValue();
    appStore.set({ settings: makeSettings(), agents: [makeAgent()], models: [] });
    render(<SettingsView section="general" />);
    expect(within(screen.getByLabelText("应用更新")).getByRole("status")).toHaveTextContent("新版本已准备好");
    expect(apply).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "更新并刷新" }));
    expect(apply).toHaveBeenCalledOnce();
  });

  it("shows both image generation paths in their own settings section", async () => {
    const model = makeModel({
      displayName: "GPT Image 2",
      modelKey: "gpt-image-2",
      capabilities: { ...makeModel().capabilities, imageOutput: true },
      imageProtocol: "openai-images"
    });
    appStore.set({
      connections: [makeConnection({ protocol: "openai-responses" })],
      models: [model]
    });

    vi.spyOn(endpoints, "serviceSettings").mockResolvedValue({ searchEngines: [], imageModels: [{ modelId: model.id, id: "openai/gpt-image-2", name: model.displayName, connectionName: "OpenAI", enabled: true, available: true, protocol: "openai-images" }] });
    render(<SettingsView section="image-generation" />);

    expect(await screen.findByRole("heading", { name: "图片工具模型" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /GPT Image 2/ })).toBeChecked();
    expect(screen.getByText("openai/gpt-image-2")).toBeInTheDocument();
    expect(screen.getByText(/此处的开关不影响直接通过 Responses/)).toBeInTheDocument();
  });

  it("stores generation haptics in application settings", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue(json(makeSettings({
      uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer", generationHaptics: false }
    })));
    vi.stubGlobal("fetch", fetchMock);
    appStore.set({ settings: makeSettings(), agents: [makeAgent()], models: [] });
    render(<SettingsView section="general" />);

    const toggle = screen.getByRole("checkbox", { name: /生成时振动/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ uiPreferences: { generationHaptics: false } })
      })
    ));
  });

  it("validates password confirmation before allowing change", async () => {
    const user = userEvent.setup();
    render(<SettingsView section="security" />);
    await user.type(screen.getByLabelText("新密码"), "abcd1234");
    await user.type(screen.getByLabelText("确认新密码"), "abcd1235");
    expect(screen.getByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(screen.getByRole("button", { name: "修改密码" })).toBeDisabled();
  });

  it("changes the password through the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/password" && init?.method === "PUT") {
        return Promise.resolve(json({ ok: true, sessionsRevoked: 2 }));
      }
      return Promise.resolve(json({}, 200));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsView section="security" />);
    await user.type(screen.getByLabelText("新密码"), "abcd1234");
    await user.type(screen.getByLabelText("确认新密码"), "abcd1234");
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已撤销 2 个旧会话"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/password",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ password: "abcd1234" }) })
    );
  });

  it("lists memories read-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/memories") {
          return Promise.resolve(
            json([{ id: 1, content: "主人喜欢咖啡", createdAt: 1, updatedAt: 2 }])
          );
        }
        return Promise.resolve(json({}, 200));
      })
    );
    render(<SettingsView section="memories" />);
    expect(await screen.findByText("主人喜欢咖啡")).toBeInTheDocument();
  });

  it("opens complete tool and environment details from compact summaries", async () => {
    const user = userEvent.setup();
    const description = "A long tool description with every detail preserved in the read-only dialog.";
    vi.spyOn(endpoints, "toolSettings").mockResolvedValue({
      enabled: { long_tool: true },
      workspaceShellEnabled: true,
      workspacePath: "/a/very/long/workspace/path",
      skillsPath: "/a/very/long/skills/path"
    });
    vi.spyOn(endpoints, "toolCatalog").mockResolvedValue([{
      name: "long_tool",
      label: "Long Tool",
      description,
      category: "workspace",
      requiresApproval: true,
      available: true,
      approvalMode: "always",
      sourceKind: "plugin",
      sourceId: "plugin-long",
      sourceName: "Long Plugin Source",
      revision: "1234567890abcdef",
      operationalState: "loaded",
      error: null
    }]);

    render(<SettingsView section="tools" />);
    const toolTrigger = await screen.findByRole("button", { name: "查看工具 Long Tool 的完整信息" });
    await user.click(toolTrigger);
    const toolDialog = screen.getByRole("dialog", { name: "工具详情 · Long Tool" });
    expect(within(toolDialog).getByText(description)).toBeInTheDocument();
    expect(within(toolDialog).getByText("long_tool")).toBeInTheDocument();
    expect(within(toolDialog).getByText("plugin-long")).toBeInTheDocument();
    await user.click(within(toolDialog).getByRole("button", { name: "关闭对话框" }));
    await waitFor(() => expect(toolTrigger).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "查看完整工作区路径" }));
    const pathDialog = screen.getByRole("dialog", { name: "工作区路径" });
    expect(within(pathDialog).getByText("/a/very/long/workspace/path")).toBeInTheDocument();
  });

  it("opens complete Skill descriptions, dependencies and errors", async () => {
    const user = userEvent.setup();
    const description = "A long Skill description that is clamped in the list and complete in its detail dialog.";
    vi.spyOn(endpoints, "skills").mockResolvedValue([{
      id: "skill-detail",
      name: "Detail Skill",
      description,
      revision: "abcdef1234567890",
      sourcePath: "/tmp/detail-skill",
      state: "error",
      error: "The complete Skill error",
      requiredTools: ["workspace_shell", "background_start"],
      recommendedApprovals: {},
      bundled: false,
      installedAt: 1,
      updatedAt: 1
    }]);

    render(<SettingsView section="skills" />);
    const trigger = await screen.findByRole("button", { name: "查看 Skill Detail Skill 的完整信息" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Skill 详情 · Detail Skill" });
    expect(within(dialog).getByText(description)).toBeInTheDocument();
    expect(within(dialog).getByText("workspace_shell")).toBeInTheDocument();
    expect(within(dialog).getByText("background_start")).toBeInTheDocument();
    expect(within(dialog).getByText("The complete Skill error")).toBeInTheDocument();
  });

  it("groups Skill, Plugin and MCP actions outside their content columns", async () => {
    vi.spyOn(endpoints, "skills").mockResolvedValue([{
      id: "skill-1",
      name: "Long Skill",
      description: "A deliberately long description that must wrap without shrinking its actions.",
      revision: "1234567890abcdef",
      sourcePath: "/tmp/skill-1",
      state: "loaded",
      error: null,
      requiredTools: ["workspace_shell"],
      recommendedApprovals: {},
      bundled: false,
      installedAt: 1,
      updatedAt: 1
    }]);
    vi.spyOn(endpoints, "plugins").mockResolvedValue([{
      id: "plugin-1",
      manifest: {
        id: "plugin-1",
        name: "Long Plugin",
        version: "1.0.0",
        apiVersion: 1,
        entry: "index.mjs",
        description: "Another long description used to exercise the shared management row.",
        secretFields: []
      },
      revision: "abcdef1234567890",
      sourcePath: "/tmp/plugin-1",
      state: "loaded",
      error: null,
      config: {},
      configuredSecretFields: [],
      installedAt: 1,
      updatedAt: 1
    }]);
    vi.spyOn(endpoints, "mcpServers").mockResolvedValue([{
      id: "mcp-1",
      name: "Long MCP",
      url: "https://example.com/mcp",
      headerNames: [],
      enabled: true,
      lastError: null,
      createdAt: 1,
      updatedAt: 1
    }]);

    for (const [section, name, actionCount] of [
      ["skills", "Long Skill", 1],
      ["plugins", "Long Plugin", 4],
      ["mcp", "Long MCP", 3]
    ] as const) {
      const view = render(<SettingsView section={section} />);
      const title = await screen.findByText(name);
      const row = title.closest(".list-row");
      expect(row?.querySelector(":scope > .list-row-content")).toContainElement(title);
      expect(row?.querySelectorAll(":scope > .list-row-actions .btn")).toHaveLength(actionCount);
      view.unmount();
    }
  });

  it("exposes connection and model creation from the embedded settings section", async () => {
    const user = userEvent.setup();
    appStore.set({ connections: [], models: [] });
    render(<SettingsView section="connections" />);

    const addConnection = screen.getByRole("button", { name: "新建连接" });
    expect(addConnection).toBeEnabled();
    expect(screen.queryByRole("button", { name: "手动添加模型" })).not.toBeInTheDocument();

    await user.click(addConnection);
    const dialog = screen.getByRole("dialog", { name: "新建连接" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("creates a connection and refreshes the embedded connection list", async () => {
    const user = userEvent.setup();
    const connection = makeConnection({
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1"
    });
    appStore.set({ connections: [], models: [], toasts: [] });
    const create = vi.spyOn(endpoints, "createConnection").mockResolvedValue(connection);
    vi.spyOn(endpoints, "connections").mockResolvedValue([connection]);
    vi.spyOn(endpoints, "models").mockResolvedValue([]);
    render(<SettingsView section="connections" />);

    await user.click(screen.getByRole("button", { name: "新建连接" }));
    await user.type(screen.getByLabelText("名称"), "OpenAI");
    await user.type(screen.getByLabelText("Base URL"), "https://api.openai.com/v1");
    await user.type(screen.getByLabelText("API Key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: "OpenAI",
      providerId: "custom",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret-key",
      secretHeaders: {}
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建连接" })).not.toBeInTheDocument());
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动添加模型" })).toBeEnabled();
  });

  it("discovers models automatically for a preset provider after saving", async () => {
    const user = userEvent.setup();
    const connection = makeConnection({
      name: "OpenAI",
      providerId: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1"
    });
    const create = vi.spyOn(endpoints, "createConnection").mockResolvedValue(connection);
    const discover = vi.spyOn(endpoints, "discoverModels").mockResolvedValue({
      discovered: 2, created: [], updated: [], skipped: 0, unmatched: 0, warnings: []
    });
    vi.spyOn(endpoints, "connections").mockResolvedValue([connection]);
    vi.spyOn(endpoints, "models").mockResolvedValue([]);
    appStore.set({ connections: [], models: [], toasts: [] });
    render(<SettingsView section="connections" />);

    await user.click(screen.getByRole("button", { name: "新建连接" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "openai");
    await user.type(screen.getByLabelText("API Key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "OpenAI",
      providerId: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret-key"
    })));
    await waitFor(() => expect(discover).toHaveBeenCalledWith(connection.id));
    expect(screen.queryByRole("dialog", { name: "新建连接" })).not.toBeInTheDocument();
  });

  it("keeps the connection editor open when creation fails", async () => {
    const user = userEvent.setup();
    appStore.set({ connections: [], models: [] });
    vi.spyOn(endpoints, "createConnection").mockRejectedValue(new Error("连接名称已存在"));
    render(<SettingsView section="connections" />);

    await user.click(screen.getByRole("button", { name: "新建连接" }));
    await user.type(screen.getByLabelText("名称"), "重复连接");
    await user.type(screen.getByLabelText("Base URL"), "https://example.com/v1");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("连接名称已存在");
    expect(screen.getByRole("dialog", { name: "新建连接" })).toBeInTheDocument();
  });
});
