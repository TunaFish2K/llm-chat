import type { AgentSummaryDto, AppSettings, ConnectionDto, ConversationDto, GenerationDto, GenerationEvent, MessageDto, ModelDto, ToolCallDto } from "@llm-chat/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const state = vi.hoisted(() => ({
  screens: { md: true, lg: true } as Record<string, boolean>,
  mediaHandlers: [] as Array<(event: MediaQueryListEvent) => void>,
  streams: new Map<string, (event: GenerationEvent) => void>(),
  unsubscribes: [] as ReturnType<typeof vi.fn>[]
}));
const api = vi.hoisted(() => ({
  settings: vi.fn(), agents: vi.fn(), connections: vi.fn(), models: vi.fn(), conversations: vi.fn(), messages: vi.fn(),
  updateConversation: vi.fn(), updateSettings: vi.fn(), startConversation: vi.fn(), send: vi.fn(), retry: vi.fn(),
  selectGeneration: vi.fn(), cancel: vi.fn(), approveTool: vi.fn(), deleteConversation: vi.fn(),
  toolCatalog: vi.fn(),
  agentAvatarUrl: vi.fn((id: string) => `/api/agents/${id}/avatar`)
}));
const generationEvents = vi.hoisted(() => vi.fn((id: string, callback: (event: GenerationEvent) => void) => {
  state.streams.set(id, callback);
  const unsubscribe = vi.fn(() => state.streams.delete(id));
  state.unsubscribes.push(unsubscribe);
  return unsubscribe;
}));

vi.mock("./api", () => ({ api, generationEvents }));
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Grid: { ...actual.Grid, useBreakpoint: () => state.screens },
    Select: (props: Record<string, unknown>) => typeof props["aria-label"] === "string" && (
      props["aria-label"].endsWith("覆盖") || props["aria-label"] === "推理强度" || props["aria-label"] === "上下文策略"
    )
      ? createElement("select", {
          "aria-label": props["aria-label"],
          className: props.className as string,
          value: props.value as string,
          onChange: (event: Event) => (props.onChange as (value: string) => void)((event.target as HTMLSelectElement).value)
        }, ...(props.options as Array<{ label: string; value: string }>).map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label)))
      : createElement(actual.Select, props),
    Collapse: ({ items }: { items: Array<{ key: string; label: unknown; extra: unknown; children: unknown }> }) => createElement("div", {},
      ...items.map((item) => createElement("section", { key: item.key }, item.label as never, item.extra as never, item.children as never))),
    Dropdown: ({ children, menu }: { children: unknown; menu: { onClick?: (value: { key: string }) => void } }) => createElement("div", {},
      children as never,
      createElement("button", { onClick: () => menu.onClick?.({ key: "full" }) }, "策略完整"),
      createElement("button", { onClick: () => menu.onClick?.({ key: "execution-settings" }) }, "执行设置"),
      createElement("button", { onClick: () => menu.onClick?.({ key: "delete" }) }, "菜单删除"))
  };
});
vi.mock("@ant-design/x", async () => {
  const { createElement } = await import("react");
  const Sender = ({ value, disabled, loading, placeholder, onChange, onSubmit, onCancel, footer }: Record<string, unknown>) => createElement("div", {},
    createElement("input", {
      "aria-label": "消息输入", value: value as string, disabled: disabled as boolean, placeholder: placeholder as string,
      onChange: (event: Event) => (onChange as (value: string) => void)((event.target as HTMLInputElement).value)
    }),
    createElement("button", { disabled: disabled as boolean, onClick: () => (onSubmit as (value: string) => void)(value as string) }, "发送"),
    loading ? createElement("button", { onClick: () => (onCancel as (() => void) | undefined)?.() }, "取消生成") : null,
    footer as never);
  const Conversations = ({ creation, items, onActiveChange, menu }: Record<string, unknown>) => createElement("div", {},
    createElement("button", { onClick: () => (creation as { onClick: () => void }).onClick() }, "新对话"),
    ...(items as Array<{ key: string; label: string }>).flatMap((item) => [
      createElement("button", { key: `go-${item.key}`, onClick: () => (onActiveChange as (id: string) => void)(item.key) }, `会话:${item.label}`),
      createElement("button", {
        key: `delete-${item.key}`,
        onClick: () => ((menu as (item: { key: string }) => { items: Array<{ onClick: () => void }> })(item).items[0]!.onClick())
      }, `删除:${item.label}`)
    ]));
  const BubbleList = ({ items, className, styles }: {
    items: Array<Record<string, unknown>>;
    className?: string;
    styles?: { root?: Record<string, unknown>; scroll?: Record<string, unknown> };
  }) => createElement("div", { "data-testid": "bubbles", className, style: styles?.root },
    createElement("div", { "data-testid": "bubble-scroll", style: styles?.scroll },
      ...items.map((item) => createElement("article", {
        key: item.key as string,
        "data-key": item.key,
        style: (item.styles as { root?: Record<string, unknown> } | undefined)?.root
      },
      item.loading ? createElement("span", {}, "loading") : null,
      typeof item.content === "string" ? item.content : item.content as never,
      item.footer as never))));
  const Actions = ({ items }: { items: Array<{ key: string; label: string; onItemClick: () => void }> }) => createElement("div", {},
    ...items.map((item) => createElement("button", { key: item.key, onClick: item.onItemClick }, item.label)));
  const Think = ({ title, children, onExpand }: Record<string, unknown>) => createElement("div", {},
    createElement("button", { onClick: () => (onExpand as (next: boolean) => void)(true) }, title as string), children as never);
  const Welcome = ({ title, description, extra }: Record<string, unknown>) => createElement("div", {}, title as string, description as string, extra as never);
  return {
    XProvider: ({ children }: { children: unknown }) => createElement("div", {}, children as never),
    Sender, Conversations, Actions, Think, Welcome,
    Bubble: { List: BubbleList }
  };
});
vi.mock("./Markdown", async () => {
  const { createElement } = await import("react");
  return { Markdown: ({ children, colorScheme }: { children: string; colorScheme: string }) => createElement("div", {
    "data-testid": "markdown",
    "data-color-scheme": colorScheme
  }, children) };
});
vi.mock("./ModelSelector", async () => {
  const { createElement } = await import("react");
  const actual = await vi.importActual<typeof import("./ModelSelector")>("./ModelSelector");
  return {
    ...actual,
    ModelSelector: ({ value, models, onChange, onGoSettings }: { value: string | null; models: ModelDto[]; onChange: (id: string) => void; onGoSettings: () => void }) => createElement("div", {},
      createElement("select", { "aria-label": "模型", value: value ?? "", onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
        ...models.map((item) => createElement("option", { key: item.id, value: item.id }, item.displayName))),
      createElement("button", { onClick: onGoSettings }, "模型设置"))
  };
});
vi.mock("./ReasoningEffortControl", async () => {
  const { createElement } = await import("react");
  return {
    ReasoningEffortControl: ({ value, onChange, saving }: { value: string; onChange: (value: string) => void; saving?: boolean }) => createElement("select", {
      "aria-label": `推理:${value}${saving ? ":保存中" : ""}`, value,
      onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value)
    }, ...["none", "low", "medium", "high", "xhigh", "max"].map((effort) => createElement("option", { key: effort }, effort)))
  };
});
vi.mock("./SettingsPanel", async () => {
  const { createElement } = await import("react");
  return {
    SettingsPanel: (props: Record<string, unknown>) => props.open ? createElement("div", { role: "dialog", "data-testid": "settings-panel" },
      createElement("span", { "data-testid": "settings-prefs" }, JSON.stringify(props.uiPreferences)),
      createElement("button", { onClick: props.onClose as () => void }, "关闭设置"),
      createElement("button", {
        onClick: () => (props.onUiPreferences as (value: unknown) => void)({ sidebarCollapsed: true, reasoningCollapsePolicy: "never-auto-collapse" })
      }, "修改界面"),
      createElement("button", {
        onClick: () => (props.onSettings as (value: AppSettings) => void)({ ...(props.settings as AppSettings), theme: "dark" })
      }, "应用设置")) : null
  };
});

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") state.mediaHandlers.push(listener);
    }),
    removeEventListener: vi.fn(), dispatchEvent: vi.fn()
  })) });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn() } });
});

const settings: AppSettings = {
  defaultModelId: "m1", defaultContextPolicy: "trim", theme: "system", defaultSystemPrompt: "",
  reasoningEffort: "medium", defaultAgentId: "agent1", lastAgentId: "agent1",
  userProfile: { displayName: "用户", description: "" },
  uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer" }
};
const connection: ConnectionDto = {
  id: "c1", name: "Primary", protocol: "openai-responses", baseUrl: "https://api.example.com",
  hasApiKey: true, secretHeaderNames: [], createdAt: 1, updatedAt: 1
};
const model: ModelDto = {
  id: "m1", connectionId: "c1", modelKey: "gpt", displayName: "GPT", contextWindow: 10000, maxOutputTokens: 1000,
  capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: true, adaptiveThinking: false, manualThinking: false },
  defaultSettings: { common: { maxOutputTokens: 500, stopSequences: [] }, protocol: {} }, enabled: true, source: "manual", createdAt: 1, updatedAt: 1
};
const agent: AgentSummaryDto = {
  id: "agent1", name: "默认助手", description: "通用助手", protected: true, revision: 1, hasAvatar: false,
  modelId: "m1", execution: { modelId: "m1", contextPolicy: "trim", reasoningEffort: "medium", generation: {}, tools: { defaultEnabled: true, overrides: {} } },
  userProfile: {}, firstMessage: "你好，用户。", alternateGreetings: [], createdAt: 1, updatedAt: 1
};
const conversation: ConversationDto = {
  id: "a1b2", title: "First chat", systemPrompt: "", contextPolicy: "trim", modelId: "m1", draft: "",
  agentId: "agent1", executionOverrides: {},
  createdAt: 1, updatedAt: 1
};
const tool = (overrides: Partial<ToolCallDto> = {}): ToolCallDto => ({
  id: "t1", index: 0, name: "workspace_shell", arguments: "{\"cmd\":\"pwd\"}", approvalState: "pending",
  requiresApproval: true, output: null, error: null, startedAt: null, completedAt: null, ...overrides
});
const generation = (overrides: Partial<GenerationDto> = {}): GenerationDto => ({
  id: "g1", version: 1, status: "completed", connectionName: "Primary", protocol: "openai-responses", modelKey: "gpt",
  settings: { common: { maxOutputTokens: 100, stopSequences: [] }, protocol: {}, reasoningEffort: "medium" },
  blocks: [{ id: "b1", index: 0, type: "text", content: "answer", complete: true }], toolCalls: [], usage: { totalTokens: 12 },
  stopReason: "end_turn", error: null, context: null, createdAt: 1, completedAt: 2, ...overrides
});
const userMessage = (text = "hello"): MessageDto => ({
  id: "u1", role: "user", text, generatedModel: null, activeGenerationId: null, generations: [], createdAt: 1
});
const assistantMessage = (generations = [generation()], activeGenerationId = generations[0]?.id ?? null): MessageDto => ({
  id: "a1", role: "assistant", text: null,
  generatedModel: { modelId: "m1", displayName: "GPT", modelKey: "gpt", connectionName: "Primary", protocol: "openai-responses" },
  activeGenerationId, generations, createdAt: 2
});

function resetApi() {
  vi.clearAllMocks();
  state.streams.clear(); state.unsubscribes = []; state.screens = { md: true, lg: true }; state.mediaHandlers = [];
  window.history.replaceState({}, "", "/");
  api.settings.mockResolvedValue(settings);
  api.agents.mockResolvedValue([agent]);
  api.connections.mockResolvedValue([connection]);
  api.models.mockResolvedValue([model]);
  api.conversations.mockResolvedValue([conversation]);
  api.messages.mockResolvedValue([]);
  api.updateConversation.mockImplementation(async (_id: string, patch: Partial<ConversationDto>) => ({ ...conversation, ...patch }));
  api.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch }));
  api.startConversation.mockResolvedValue({ conversation, generation: { assistantMessageId: "a1", generationId: "g-live" } });
  api.send.mockResolvedValue({ assistantMessageId: "a1", generationId: "g-live" });
  api.retry.mockResolvedValue({ assistantMessageId: "a1", generationId: "g-retry" });
  api.selectGeneration.mockResolvedValue({ ok: true });
  api.cancel.mockResolvedValue({ ok: true });
  api.approveTool.mockResolvedValue({ toolCall: tool(), generationId: "g-resumed", resumed: true });
  api.deleteConversation.mockResolvedValue(undefined);
  api.toolCatalog.mockResolvedValue([{ name: "web_search", label: "Web search", description: "Search", category: "web", requiresApproval: false, available: true }]);
}

async function boot(path = "/") {
  window.history.replaceState({}, "", path);
  render(<App />);
  await waitFor(() => expect(api.conversations).toHaveBeenCalled());
}

describe("App", () => {
  beforeEach(resetApi);

  it("shows boot loading, retains loading after an error, and renders a ready welcome", async () => {
    let resolveSettings!: (value: AppSettings) => void;
    api.settings.mockReturnValueOnce(new Promise((resolve) => { resolveSettings = resolve; }));
    render(<App />);
    expect(screen.getByText("正在启动 llm-chat")).toBeInTheDocument();
    resolveSettings(settings);
    expect(await screen.findByRole("heading", { name: "默认助手" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    expect(document.querySelector(".app-theme-root")).toHaveAttribute("data-color-scheme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("keeps an explicit dark theme when the system preference changes", async () => {
    api.settings.mockResolvedValue({ ...settings, theme: "dark" });
    api.messages.mockResolvedValue([assistantMessage()]);
    await boot("/c/a1b2");

    expect(await screen.findByText("answer")).toHaveAttribute("data-color-scheme", "dark");
    expect(document.querySelector(".app-theme-root")).toHaveAttribute("data-color-scheme", "dark");
    act(() => state.mediaHandlers.forEach((handler) => handler({ matches: false } as MediaQueryListEvent)));
    expect(document.querySelector(".app-theme-root")).toHaveAttribute("data-color-scheme", "dark");
  });

  it("lets the desktop message list CSS rail own its width", async () => {
    api.messages.mockResolvedValue([userMessage()]);
    await boot("/c/a1b2");

    const list = await screen.findByTestId("bubbles");
    expect(list).toHaveClass("message-list");
    expect(list.style.height).toBe("100%");
    expect(list.style.width).toBe("");
    expect(screen.getByTestId("bubble-scroll").style.paddingBlock).toBe("24px 32px");
    expect(list.querySelector("article")).toHaveStyle({ width: "100%", marginInline: "auto" });
  });

  it("keeps a mobile gutter inside the aligned message rail", async () => {
    state.screens = { md: false, lg: false };
    api.messages.mockResolvedValue([userMessage()]);
    await boot("/c/a1b2");

    const list = await screen.findByTestId("bubbles");
    expect(list.style.width).toBe("");
    expect(screen.getByTestId("bubble-scroll").style.paddingBlock).toBe("16px 24px");
    expect(list.querySelector("article")).toHaveStyle({ width: "calc(100% - 8px)", marginInline: "auto" });
  });

  it("uses a single-row mobile welcome toolbar with a shared execution popup", async () => {
    const user = userEvent.setup();
    state.screens = { md: false, lg: false };
    api.conversations.mockResolvedValue([]);
    await boot();

    const toolbar = document.querySelector(".composer-toolbar-mobile");
    expect(toolbar).toBeInTheDocument();
    expect(toolbar).toHaveClass("composer-toolbar");
    expect(screen.queryByRole("combobox", { name: /推理:/ })).not.toBeInTheDocument();
    expect(document.querySelector(".context-selector")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "调整推理强度和上下文策略" }));
    expect(screen.getByText("推理强度")).toBeInTheDocument();
    expect(screen.getByText("上下文策略")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "推理强度" }), "high");
    await user.selectOptions(screen.getByRole("combobox", { name: "上下文策略" }), "full");
    expect(screen.getByRole("combobox", { name: "推理强度" })).toHaveValue("high");
    expect(screen.getByRole("combobox", { name: "上下文策略" })).toHaveValue("full");
  });

  it("keeps four direct execution controls on desktop", async () => {
    await boot("/c/a1b2");
    expect(document.querySelector(".composer-toolbar-mobile")).not.toBeInTheDocument();
    expect(document.querySelector(".context-selector")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /推理:medium/ })).toBeInTheDocument();
  });

  it("uses the same mobile execution popup in an existing session", async () => {
    const user = userEvent.setup();
    state.screens = { md: false, lg: false };
    await boot("/c/a1b2");
    await user.click(screen.getByRole("button", { name: "调整推理强度和上下文策略" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "推理强度" }), "high");
    await user.selectOptions(screen.getByRole("combobox", { name: "上下文策略" }), "full");
    await waitFor(() => {
      expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
        executionOverrides: expect.objectContaining({ reasoningEffort: "high" })
      });
      expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
        executionOverrides: expect.objectContaining({ contextPolicy: "full" })
      });
    });
  });

  it("keeps the boot surface when boot fails", async () => {
    api.settings.mockRejectedValueOnce(new Error("boot failed"));
    render(<App />);
    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    expect(screen.getByText("正在启动 llm-chat")).toBeInTheDocument();
  });

  it("renders missing connection and model states and opens settings", async () => {
    const user = userEvent.setup();
    api.connections.mockResolvedValue([]);
    await boot();
    expect(await screen.findByText(/先添加一个模型连接/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });

  it("renders the missing-model state and opens model management", async () => {
    const user = userEvent.setup();
    api.models.mockResolvedValue([]);
    await boot();
    expect(await screen.findByText(/连接已建立，还需要模型/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理模型" }));
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
  });

  it("keeps a deleted Agent detached and disables sending until the user selects one", async () => {
    api.conversations.mockResolvedValue([{ ...conversation, agentId: null }]);
    await boot("/c/a1b2");
    expect(await screen.findByText("当前 Agent 已删除，请重新选择")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveAttribute("placeholder", "请先选择 Agent");
  });

  it("previews greeting placeholders with the effective global user profile", async () => {
    api.settings.mockResolvedValue({ ...settings, userProfile: { displayName: "Lin", description: "" } });
    api.agents.mockResolvedValue([{ ...agent, firstMessage: "你好，{{user}}。" }]);
    api.conversations.mockResolvedValue([]);
    await boot();
    expect(await screen.findByText("你好，Lin。")).toBeInTheDocument();
  });

  it("starts a conversation from welcome and restores the draft after failure", async () => {
    const user = userEvent.setup();
    api.conversations.mockResolvedValue([]);
    await boot();
    const input = screen.getByRole("textbox", { name: "消息输入" });
    await user.type(input, " hello ");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.startConversation).toHaveBeenCalledWith({
      text: "hello", agentId: "agent1", greetingIndex: 0, executionOverrides: {}
    }));
    expect(window.location.pathname).toBe("/c/a1b2");
    expect(generationEvents).toHaveBeenCalledWith("g-live", expect.any(Function));

    await user.click(screen.getByRole("button", { name: "新对话" }));
    api.startConversation.mockRejectedValueOnce(new Error("start failed"));
    await user.type(screen.getByRole("textbox", { name: "消息输入" }), "again");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("start failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("again");
  });

  it("derives the current conversation from the route and edits title, model, and context", async () => {
    const user = userEvent.setup();
    api.messages.mockResolvedValue([userMessage(), assistantMessage()]);
    await boot("/c/a1b2");
    expect(await screen.findByText("answer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "First chat" }));
    const title = screen.getByRole("textbox", { name: "会话标题" });
    await user.clear(title); await user.type(title, " Renamed "); fireEvent.keyDown(title, { key: "Enter" });
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", { title: "Renamed" }));
    await user.click(screen.getByRole("button", { name: "Renamed" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "会话标题" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "会话标题" })).not.toBeInTheDocument();
    fireEvent.change(screen.getAllByRole("combobox", { name: "模型" })[0]!, { target: { value: "m1" } });
    await user.click(screen.getByRole("button", { name: "策略完整" }));
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
      executionOverrides: { modelId: "m1", contextPolicy: "full" }
    }));
  });

  it("edits and restores advanced conversation execution overrides", async () => {
    const user = userEvent.setup();
    await boot("/c/a1b2");
    await user.click(screen.getByRole("button", { name: "执行设置" }));
    expect(await screen.findByText("会话执行设置")).toBeInTheDocument();

    const modelOverride = screen.getByRole("combobox", { name: "会话模型覆盖" });
    await user.selectOptions(modelOverride, "unavailable");
    expect(modelOverride).toHaveValue("unavailable");
    await user.selectOptions(screen.getByRole("combobox", { name: "会话上下文覆盖" }), "full");
    await user.selectOptions(screen.getByRole("combobox", { name: "会话推理强度覆盖" }), "high");
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Temperature 覆盖" }), { target: { value: "0.7" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Top P 覆盖" }), { target: { value: "0.8" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话最大输出覆盖" }), { target: { value: "2048" } });
    fireEvent.change(screen.getByRole("textbox", { name: "会话停止序列覆盖" }), { target: { value: "END\nDONE" } });
    const summaryOverride = screen.getByRole("combobox", { name: "会话推理摘要覆盖" });
    await user.selectOptions(summaryOverride, "concise");
    expect(summaryOverride).toHaveValue("concise");
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Thinking token 预算覆盖" }), { target: { value: "4096" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Web search 覆盖" })).toBeInTheDocument());
    const toolOverride = screen.getByRole("combobox", { name: "Web search 覆盖" });
    await user.selectOptions(toolOverride, "disabled");
    expect(toolOverride).toHaveValue("disabled");
    await user.click(screen.getByRole("button", { name: "恢复 Agent 默认" }));
    await user.click(document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement);
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", { executionOverrides: {} }));
  });

  it("navigates, creates, and deletes conversations", async () => {
    const user = userEvent.setup();
    await boot("/c/a1b2");
    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(window.location.pathname).toBe("/");
    await user.click(screen.getByRole("button", { name: "会话:First chat" }));
    expect(window.location.pathname).toBe("/c/a1b2");
    await user.click(screen.getByRole("button", { name: "删除:First chat" }));
    expect(screen.getByText(/删除会话“First chat”/)).toBeInTheDocument();
    await user.click(document.querySelector(".ant-modal-footer .ant-btn-default") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "删除:First chat" }));
    await user.click(document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement);
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith("a1b2"));
  });

  it("sends a message in an existing conversation and follows popstate navigation", async () => {
    const user = userEvent.setup();
    api.messages.mockResolvedValue([assistantMessage()]);
    await boot("/c/a1b2");
    await user.type(screen.getByRole("textbox", { name: "消息输入" }), " next ");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("a1b2", { text: "next" }));
    expect(generationEvents).toHaveBeenCalledWith("g-live", expect.any(Function));

    window.history.pushState({}, "", "/");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await screen.findByRole("heading", { name: "默认助手" })).toBeInTheDocument();
  });

  it("sends, retries, selects a generation, copies, and cancels", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const old = generation({ id: "g0", version: 1, blocks: [{ id: "old", index: 0, type: "text", content: "old answer", complete: true }] });
    const running = generation({ id: "g1", version: 2, status: "running", blocks: [] });
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, running], "g1")]);
    await boot("/c/a1b2");
    expect(await screen.findByRole("button", { name: "取消生成" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消生成" }));
    expect(api.cancel).toHaveBeenCalledWith("g1");
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, generation({ id: "g1", version: 2 })], "g1")]);
    act(() => state.streams.get("g1")?.({ type: "status", generationId: "g1", status: "completed" }));
    await waitFor(() => expect(state.unsubscribes.some((unsubscribe) => unsubscribe.mock.calls.length)).toBe(true));
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, generation({ id: "g1", version: 2 })], "g0")]);
    await user.click(screen.getByTitle("上一版本"));
    await waitFor(() => expect(api.selectGeneration).toHaveBeenCalledWith("a1", "g0"));
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("old answer");
    await user.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith("a1"));
  });

  it("applies live SSE updates and refreshes on terminal snapshots", async () => {
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "running", blocks: [] })])]);
    await boot("/c/a1b2");
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g1", expect.any(Function)));
    act(() => state.streams.get("g1")?.({ type: "block-delta", generationId: "g1", block: { id: "b", index: 0, type: "text", content: "streamed", complete: false } }));
    expect(await screen.findByText("streamed")).toBeInTheDocument();
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "waiting-approval" })])]);
    act(() => state.streams.get("g1")?.({ type: "snapshot", generation: generation({ status: "waiting-approval" }) }));
    await waitFor(() => expect(api.conversations).toHaveBeenCalledTimes(2));
    expect(state.unsubscribes.some((unsubscribe) => unsubscribe.mock.calls.length)).toBe(true);
  });

  it("approves and denies tools and resumes generation when requested", async () => {
    const user = userEvent.setup();
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "completed", toolCalls: [tool()] })])]);
    await boot("/c/a1b2");
    expect(await screen.findByText("answer")).toBeInTheDocument();
    const resumed = generation({ id: "g-resumed", status: "running", blocks: [], toolCalls: [tool()] });
    api.messages.mockResolvedValue([assistantMessage([resumed], "g-resumed")]);
    await user.click(await screen.findByRole("button", { name: /允许/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t1", true));
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g-resumed", expect.any(Function)));
    api.approveTool.mockResolvedValueOnce({ toolCall: tool(), generationId: "g", resumed: false });
    await user.click(screen.getByRole("button", { name: /拒绝/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t1", false));
  }, 120_000);

  it("optimistically updates UI settings and keeps new-conversation reasoning local", async () => {
    const user = userEvent.setup();
    await boot();
    let rejectUi!: (reason: Error) => void;
    api.updateSettings.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectUi = reject; }));
    await user.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(await screen.findByRole("button", { name: "打开会话栏" })).toBeInTheDocument();
    rejectUi(new Error("ui failed"));
    expect(await screen.findByText("ui failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "收起会话栏" })).toBeInTheDocument());

    fireEvent.change(screen.getAllByRole("combobox", { name: /推理:medium/ })[0]!, { target: { value: "high" } });
    expect(screen.getAllByRole("combobox", { name: /推理:high/ })[0]).toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("opens and closes settings and accepts settings callbacks on mobile", async () => {
    const user = userEvent.setup();
    state.screens = { md: false, lg: false };
    await boot();
    await user.click(screen.getByRole("button", { name: "打开会话栏" }));
    const mobileSidebar = document.querySelector(".ant-drawer-left .sidebar-content") as HTMLElement;
    await user.click(within(mobileSidebar).getByText("设置").closest("button")!);
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "修改界面" }));
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ uiPreferences: { sidebarCollapsed: true, reasoningCollapsePolicy: "never-auto-collapse" } }));
    await user.click(screen.getByRole("button", { name: "应用设置" }));
    await user.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });
});
