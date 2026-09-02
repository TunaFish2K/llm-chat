import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { endpoints } from "../lib/api";
import { appStore } from "../lib/app-state";
import { SettingsView } from "./SettingsView";
import { makeAgent, makeConnection, makeSettings } from "../../test/fixtures";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SettingsView", () => {
  it("renders the general section with theme control", () => {
    appStore.set({ settings: makeSettings(), agents: [makeAgent()], models: [] });
    render(<SettingsView section="general" />);
    expect(screen.getByLabelText("主题")).toHaveValue("dark");
    expect(screen.getByLabelText("默认推理档位")).toHaveValue("medium");
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
      ["skills", "Long Skill", 2],
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
    expect(screen.getByRole("button", { name: "手动添加模型" })).toBeDisabled();

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
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret-key",
      secretHeaders: {}
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建连接" })).not.toBeInTheDocument());
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动添加模型" })).toBeEnabled();
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
