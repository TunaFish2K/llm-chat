import type { AgentSummaryDto, AppSettings, BackgroundTaskDto, ConnectionDto, ConversationDto, GenerationDto, GenerationEvent, MessageDto, ModelDto, ToolCallDto } from "@llm-chat/contracts";
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
  toolCatalog: vi.fn(), connectionBalance: vi.fn(),
  directories: vi.fn(), createDirectory: vi.fn(),
  backgroundTasks: vi.fn(), backgroundOutput: vi.fn(), backgroundTask: vi.fn(), stopBackgroundTask: vi.fn(),
  agentAvatarUrl: vi.fn((id: string) => `/api/agents/${id}/avatar`)
}));
const generationEvents = vi.hoisted(() => vi.fn((id: string, callback: (event: GenerationEvent) => void) => {
  state.streams.set(id, callback);
  const unsubscribe = vi.fn(() => state.streams.delete(id));
  state.unsubscribes.push(unsubscribe);
  return unsubscribe;
}));
const appEvents = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("./api", () => ({ api, generationEvents, appEvents }));
vi.mock("@ant-design/icons", async () => {
  const { createElement } = await import("react");
  const Icon = () => createElement("span", { "aria-hidden": true });
  return {
    CheckOutlined: Icon, CloseOutlined: Icon, CodeOutlined: Icon, ControlOutlined: Icon,
    CopyOutlined: Icon, DeleteOutlined: Icon, FolderOpenOutlined: Icon, LeftOutlined: Icon,
    MenuFoldOutlined: Icon, MenuOutlined: Icon, MenuUnfoldOutlined: Icon, MoreOutlined: Icon,
    RightOutlined: Icon, SettingOutlined: Icon, StopOutlined: Icon, SyncOutlined: Icon,
    DownOutlined: Icon, LoadingOutlined: Icon, SearchOutlined: Icon, WalletOutlined: Icon, WarningOutlined: Icon
  };
});
vi.mock("./theme", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    resolveColorScheme: (theme: AppSettings["theme"], systemDark: boolean) => theme === "system" ? systemDark ? "dark" : "light" : theme,
    AppTheme: ({ colorScheme, children }: { colorScheme: string; children: unknown }) => {
      useEffect(() => { document.documentElement.style.colorScheme = colorScheme; }, [colorScheme]);
      return createElement("div", { className: "app-theme-root", "data-color-scheme": colorScheme }, children as never);
    }
  };
});
vi.mock("antd", async () => {
  const { cloneElement, createElement, isValidElement, useState } = await import("react");
  const Flex = ({ children, vertical, className, style }: Record<string, unknown>) => createElement("div", {
    className: className as string,
    style: { display: "flex", flexDirection: vertical ? "column" : "row", ...(style as object | undefined) }
  }, children as never);
  const Button = ({ children, icon, htmlType, href, className, disabled, onClick, title, ...props }: Record<string, unknown>) => {
    const attributes = {
      className: className as string, disabled: disabled as boolean, onClick: onClick as never, title: title as string,
      "aria-label": props["aria-label"] as string | undefined
    };
    return href
      ? createElement("a", { ...attributes, href: href as string }, icon as never, children as never)
      : createElement("button", { ...attributes, type: (htmlType as string | undefined) ?? "button" }, icon as never, children as never);
  };
  const Select = ({ options = [], value, onChange, className, ...props }: Record<string, unknown>) => createElement("select", {
    className: className as string,
    "aria-label": props["aria-label"] as string | undefined,
    value: value === null || value === undefined ? "" : value as string,
    onChange: (event: Event) => (onChange as ((value: string) => void) | undefined)?.((event.target as HTMLSelectElement).value)
  }, ...(options as Array<{ label: unknown; value: string }>).map((option) =>
    createElement("option", { key: option.value, value: option.value }, typeof option.label === "string" ? option.label : option.value)));
  const Input = ({ onPressEnter, onKeyDown, ...props }: Record<string, unknown>) => createElement("input", {
    ...props,
    onKeyDown: (event: KeyboardEvent) => {
      (onKeyDown as ((event: KeyboardEvent) => void) | undefined)?.(event);
      if (event.key === "Enter") (onPressEnter as ((event: KeyboardEvent) => void) | undefined)?.(event);
    }
  });
  Input.TextArea = (props: Record<string, unknown>) => createElement("textarea", props);
  Input.Search = ({ onSearch, enterButton: _enterButton, ...props }: Record<string, unknown>) => createElement("input", {
    ...props,
    onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter") (onSearch as ((value: string) => void) | undefined)?.((event.target as HTMLInputElement).value); }
  });
  const InputNumber = ({ value, onChange, ...props }: Record<string, unknown>) => createElement("input", {
    ...props, type: "number", value: value === null || value === undefined ? "" : value,
    onChange: (event: Event) => {
      const next = (event.target as HTMLInputElement).value;
      (onChange as ((value: number | null) => void) | undefined)?.(next === "" ? null : Number(next));
    }
  });
  const Layout = ({ children, className }: Record<string, unknown>) => createElement("div", { className: className as string }, children as never);
  Layout.Sider = ({ children, className }: Record<string, unknown>) => createElement("aside", { className: className as string }, children as never);
  Layout.Header = ({ children, className }: Record<string, unknown>) => createElement("header", { className: className as string }, children as never);
  Layout.Content = ({ children, className }: Record<string, unknown>) => createElement("main", { className: className as string }, children as never);
  const Space = ({ children, className }: Record<string, unknown>) => createElement("div", { className: className as string }, children as never);
  Space.Compact = Space;
  const Text = ({ children, strong, className }: Record<string, unknown>) => createElement("span", { className: className as string }, strong ? createElement("strong", {}, children as never) : children as never);
  const Typography = {
    Text,
    Title: ({ children, level = 2 }: Record<string, unknown>) => createElement(`h${level}`, {}, children as never),
    Paragraph: ({ children, className }: Record<string, unknown>) => createElement("p", { className: className as string }, children as never)
  };
  const Collapse = ({ items = [] }: { items?: Array<{ key: string; label: unknown; extra?: unknown; children: unknown }> }) => createElement("div", {},
    ...items.map((item) => createElement("section", { key: item.key }, item.label as never, item.extra as never, item.children as never)));
  const Drawer = ({ open, children, title, placement, onClose: _onClose }: Record<string, unknown>) => open ? createElement("div", {
    className: placement === "left" ? "ant-drawer-left" : "ant-drawer"
  }, title as never, children as never) : null;
  const Modal = ({ open, title, children, onCancel, onOk, okText = "确定", cancelText = "取消", footer }: Record<string, unknown>) => {
    if (!open) return null;
    const CancelBtn = () => createElement("button", { className: "ant-btn-default", onClick: onCancel as never }, cancelText as never);
    const OkBtn = () => createElement("button", { className: "ant-btn-primary", onClick: onOk as never }, okText as never);
    const actions = typeof footer === "function"
      ? (footer as (origin: unknown, components: { OkBtn: typeof OkBtn; CancelBtn: typeof CancelBtn }) => unknown)(null, { OkBtn, CancelBtn })
      : createElement("div", { className: "ant-modal-footer" }, createElement(CancelBtn), createElement(OkBtn));
    return createElement("div", { role: "dialog" }, createElement("h2", {}, title as never), children as never, actions as never);
  };
  const Popover = ({ children, content }: { children: unknown; content: unknown }) => {
    const [open, setOpen] = useState(false);
    const child = isValidElement(children) ? cloneElement(children, { onClick: () => setOpen((value) => !value) } as never) : children;
    return createElement("div", {}, child as never, open ? content as never : null);
  };
  const Listy = ({ items = [], itemRender }: { items?: unknown[]; itemRender?: (item: unknown) => unknown }) => createElement("div", {},
    ...items.map((item, index) => createElement("div", { key: index }, itemRender?.(item) as never)));
  return {
    Alert: ({ title, onClose }: Record<string, unknown>) => createElement("div", { role: "alert" }, title as never, onClose ? createElement("button", { onClick: onClose as never }, "关闭") : null),
    Avatar: ({ children }: Record<string, unknown>) => createElement("div", {}, children as never),
    Badge: ({ children, className, count }: Record<string, unknown>) => createElement("div", { className: className as string },
      count ? createElement("span", {}, count as never) : null, children as never),
    Breadcrumb: ({ items = [] }: { items?: Array<{ title: unknown }> }) => createElement("nav", {}, ...items.map((item, index) => createElement("span", { key: index }, item.title as never))),
    Button, Checkbox: ({ children, checked, onChange }: Record<string, unknown>) => createElement("label", {}, createElement("input", { type: "checkbox", checked, onChange }), children as never),
    Collapse, Drawer, Flex, Grid: { useBreakpoint: () => state.screens }, Input, InputNumber, Layout, Listy, Modal, Popover, Select, Space,
    Spin: () => createElement("span", {}, "loading"),
    Switch: ({ checked, onChange }: Record<string, unknown>) => createElement("input", { type: "checkbox", checked, onChange: (event: Event) => (onChange as ((value: boolean) => void) | undefined)?.((event.target as HTMLInputElement).checked) }),
    Tag: ({ children }: Record<string, unknown>) => createElement("span", {}, children as never),
    Tooltip: ({ children, onClick }: Record<string, unknown>) => isValidElement(children)
      ? cloneElement(children, onClick ? { onClick } as never : {})
      : children,
    Typography,
    Dropdown: ({ children, menu }: { children: unknown; menu: { items?: Array<{ key: string; label?: unknown }>; onClick?: (value: { key: string }) => void } }) => {
      const [open, setOpen] = useState(false);
      const hasItem = (key: string) => menu.items?.some((item) => item.key === key);
      const taskItem = menu.items?.find((item) => item.key === "background-tasks");
      const trigger = isValidElement(children)
        ? cloneElement(children, { onClick: () => setOpen((value) => !value) } as never)
        : children;
      return createElement("div", {},
        trigger as never,
        open ? createElement("div", { role: "menu" },
          hasItem("background-tasks") ? createElement("button", { onClick: () => menu.onClick?.({ key: "background-tasks" }) }, taskItem?.label as never) : null,
          hasItem("context") ? createElement("button", { onClick: () => menu.onClick?.({ key: "full" }) }, "策略完整") : null,
          hasItem("execution-settings") ? createElement("button", { onClick: () => menu.onClick?.({ key: "execution-settings" }) }, "执行设置") : null,
          hasItem("delete") ? createElement("button", { onClick: () => menu.onClick?.({ key: "delete" }) }, "菜单删除") : null
        ) : null);
    }
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
vi.mock("./TaskTerminal", async () => {
  const { createElement } = await import("react");
  return { TaskTerminal: ({ raw }: { raw: string }) => createElement("pre", { "data-testid": "task-terminal" }, raw) };
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
  uiPreferences: { sidebarCollapsed: false, reasoningCollapsePolicy: "collapse-on-answer" }, lastWorkspacePath: null
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
  modelId: "m1", execution: { modelId: "m1", contextPolicy: "trim", reasoningEffort: "medium", generation: {}, tools: { defaultEnabled: true, overrides: {}, approvalOverrides: {} }, enabledSkillIds: [], maxToolRounds: 32, maxBackgroundTasks: 2, taskLogLimitBytes: 64 * 1024 * 1024 },
  userProfile: {}, firstMessage: "你好，用户。", alternateGreetings: [], createdAt: 1, updatedAt: 1
};
const conversation: ConversationDto = {
  id: "a1b2", title: "First chat", systemPrompt: "", contextPolicy: "trim", modelId: "m1", draft: "",
  agentId: "agent1", executionOverrides: {}, workspacePath: null,
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
  api.connectionBalance.mockResolvedValue({ connectionId: "c1", value: 1, fetchedAt: 1, cached: false });
  api.directories.mockResolvedValue({ path: "/workspace", parentPath: "/", entries: [] });
  api.createDirectory.mockResolvedValue({ path: "/workspace/new" });
  api.backgroundTasks.mockResolvedValue([]);
  api.backgroundOutput.mockResolvedValue({ task: {}, cursor: 0, earliestCursor: 0, gap: false, raw: "", text: "", screen: null });
  api.backgroundTask.mockResolvedValue({ task: {}, events: [] });
}

const backgroundTask = (overrides: Partial<BackgroundTaskDto> = {}): BackgroundTaskDto => ({
  id: "task-running", conversationId: "a1b2", generationId: "g1", agentId: "agent1", agentName: "默认助手",
  agentRevision: 1, command: "npm test", mode: "pipe", workspacePath: "/workspace", status: "running",
  expectedDurationMs: 60_000, hardTimeoutMs: 120_000, overdue: false, exitCode: null, error: null,
  outputCursor: 8, earliestCursor: 0, createdAt: 1, startedAt: 2, completedAt: null, ...overrides
});

async function boot(path = "/") {
  window.history.replaceState({}, "", path);
  render(<App />);
  await waitFor(() => expect(api.conversations).toHaveBeenCalled());
}

export function registerAppShellTests() {
  describe("App shell", () => {
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

    expect(await screen.findByTestId("markdown")).toHaveAttribute("data-color-scheme", "dark");
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
    state.screens = { md: false, lg: false };
    api.conversations.mockResolvedValue([]);
    await boot();

    const toolbar = document.querySelector(".composer-toolbar-mobile");
    expect(toolbar).toBeInTheDocument();
    expect(toolbar).toHaveClass("composer-toolbar");
    expect(screen.queryByRole("combobox", { name: /推理:/ })).not.toBeInTheDocument();
    expect(document.querySelector(".context-selector")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "调整推理强度和上下文策略" }));
    expect(screen.getByText("推理强度")).toBeInTheDocument();
    expect(screen.getByText("上下文策略")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "推理强度" }), { target: { value: "high" } });
    fireEvent.change(screen.getByRole("combobox", { name: "上下文策略" }), { target: { value: "full" } });
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
    state.screens = { md: false, lg: false };
    await boot("/c/a1b2");
    fireEvent.click(screen.getByRole("button", { name: "调整推理强度和上下文策略" }));
    fireEvent.change(screen.getByRole("combobox", { name: "推理强度" }), { target: { value: "high" } });
    fireEvent.change(screen.getByRole("combobox", { name: "上下文策略" }), { target: { value: "full" } });
    await waitFor(() => {
      expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
        executionOverrides: expect.objectContaining({ reasoningEffort: "high" })
      });
      expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
        executionOverrides: expect.objectContaining({ contextPolicy: "full" })
      });
    });
  });

  it("moves the current conversation task action into the compact menu", async () => {
    state.screens = { md: false, lg: false };
    await boot("/c/a1b2");

    expect(document.querySelector(".task-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "后台任务" })).toBeInTheDocument();
  });

  it("keeps the standalone task action on compact welcome", async () => {
    state.screens = { md: false, lg: false };
    api.conversations.mockResolvedValue([]);
    await boot();

    expect(document.querySelector(".task-badge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "后台任务" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "会话操作" })).not.toBeInTheDocument();
  });

  it("keeps the standalone task action and omits the menu duplicate on desktop", async () => {
    await boot("/c/a1b2");

    expect(document.querySelector(".task-badge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    expect(screen.getByRole("menu")).not.toHaveTextContent("后台任务");
    expect(screen.getAllByRole("button", { name: "后台任务" })).toHaveLength(1);
  });

  it("opens the task drawer from the compact conversation menu", async () => {
    state.screens = { md: false, lg: false };
    api.backgroundTasks.mockResolvedValue([backgroundTask()]);
    await boot("/c/a1b2");

    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(await screen.findByRole("button", { name: "后台任务 1" }));
    expect(await screen.findAllByText("npm test")).not.toHaveLength(0);
    expect(document.querySelector(".ant-drawer")).toBeInTheDocument();
  });

  it("counts only queued, starting, and running tasks in the compact menu", async () => {
    state.screens = { md: false, lg: false };
    api.backgroundTasks.mockResolvedValue([
      backgroundTask({ id: "task-running", status: "running" }),
      backgroundTask({ id: "task-starting", status: "starting" }),
      backgroundTask({ id: "task-queued", status: "queued" }),
      backgroundTask({ id: "task-completed", status: "completed" })
    ]);
    await boot("/c/a1b2");

    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    expect(await screen.findByRole("button", { name: "后台任务 3" })).toBeInTheDocument();
  });

  it("keeps the boot surface when boot fails", async () => {
    api.settings.mockRejectedValueOnce(new Error("boot failed"));
    render(<App />);
    await waitFor(() => expect(api.settings).toHaveBeenCalled());
    expect(screen.getByText("正在启动 llm-chat")).toBeInTheDocument();
  });

  it("renders missing connection and model states and opens settings", async () => {
    api.connections.mockResolvedValue([]);
    await boot();
    expect(await screen.findByText(/先添加一个模型连接/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(await screen.findByTestId("settings-panel")).toBeInTheDocument();
  });

  it("renders the missing-model state and opens model management", async () => {
    api.models.mockResolvedValue([]);
    await boot();
    expect(await screen.findByText(/连接已建立，还需要模型/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理模型" }));
    expect(await screen.findByTestId("settings-panel")).toBeInTheDocument();
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
  });
}

export function registerAppConversationTests() {
  describe("App conversations", () => {
    beforeEach(resetApi);
  it("starts a conversation from welcome and restores the draft after failure", async () => {
    api.conversations.mockResolvedValue([]);
    await boot();
    const input = screen.getByRole("textbox", { name: "消息输入" });
    fireEvent.change(input, { target: { value: " hello " } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.startConversation).toHaveBeenCalledWith({
      text: "hello", agentId: "agent1", greetingIndex: 0, executionOverrides: {}, workspacePath: null
    }));
    expect(window.location.pathname).toBe("/c/a1b2");
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g-live", expect.any(Function)));

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    api.startConversation.mockRejectedValueOnce(new Error("start failed"));
    fireEvent.change(screen.getByRole("textbox", { name: "消息输入" }), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("start failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("again");
  });

  it("derives the current conversation from the route and edits title, model, and context", async () => {
    api.messages.mockResolvedValue([userMessage(), assistantMessage()]);
    await boot("/c/a1b2");
    expect(await screen.findByTestId("markdown")).toHaveTextContent("answer");
    fireEvent.click(screen.getByRole("button", { name: "First chat" }));
    const title = screen.getByRole("textbox", { name: "会话标题" });
    fireEvent.change(title, { target: { value: " Renamed " } });
    fireEvent.keyDown(title, { key: "Enter" });
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", { title: "Renamed" }));
    fireEvent.click(screen.getByRole("button", { name: "Renamed" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "会话标题" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "会话标题" })).not.toBeInTheDocument();
    fireEvent.change(screen.getAllByRole("combobox", { name: "模型" })[0]!, { target: { value: "m1" } });
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
      executionOverrides: { modelId: "m1" }
    }));
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(screen.getByRole("button", { name: "策略完整" }));
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", {
      executionOverrides: { modelId: "m1", contextPolicy: "full" }
    }));
  });

  it("edits and restores advanced conversation execution overrides", async () => {
    await boot("/c/a1b2");
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(screen.getByRole("button", { name: "执行设置" }));
    expect(await screen.findByText("会话执行设置")).toBeInTheDocument();

    const modelOverride = screen.getByRole("combobox", { name: "会话模型覆盖" });
    fireEvent.change(modelOverride, { target: { value: "unavailable" } });
    expect(modelOverride).toHaveValue("unavailable");
    fireEvent.change(screen.getByRole("combobox", { name: "会话上下文覆盖" }), { target: { value: "full" } });
    fireEvent.change(screen.getByRole("combobox", { name: "会话推理强度覆盖" }), { target: { value: "high" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Temperature 覆盖" }), { target: { value: "0.7" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Top P 覆盖" }), { target: { value: "0.8" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话最大输出覆盖" }), { target: { value: "2048" } });
    fireEvent.change(screen.getByRole("textbox", { name: "会话停止序列覆盖" }), { target: { value: "END\nDONE" } });
    const summaryOverride = screen.getByRole("combobox", { name: "会话推理摘要覆盖" });
    fireEvent.change(summaryOverride, { target: { value: "concise" } });
    expect(summaryOverride).toHaveValue("concise");
    fireEvent.change(screen.getByRole("spinbutton", { name: "会话 Thinking token 预算覆盖" }), { target: { value: "4096" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Web search 覆盖" })).toBeInTheDocument());
    const toolOverride = screen.getByRole("combobox", { name: "Web search 覆盖" });
    fireEvent.change(toolOverride, { target: { value: "disabled" } });
    expect(toolOverride).toHaveValue("disabled");
    fireEvent.click(screen.getByRole("button", { name: "恢复 Agent 默认" }));
    fireEvent.click(document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement);
    await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", { executionOverrides: {} }));
  });
  });
}

export function registerAppMessagingTests() {
  describe("App messaging", () => {
    beforeEach(resetApi);
  it("navigates, creates, and deletes conversations", async () => {
    await boot("/c/a1b2");
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "会话:First chat" }));
    expect(window.location.pathname).toBe("/c/a1b2");
    fireEvent.click(screen.getByRole("button", { name: "删除:First chat" }));
    expect(screen.getByText(/删除会话“First chat”/)).toBeInTheDocument();
    fireEvent.click(document.querySelector(".ant-modal-footer .ant-btn-default") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "删除:First chat" }));
    fireEvent.click(document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement);
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith("a1b2"));
  });

  it("sends a message in an existing conversation and follows popstate navigation", async () => {
    const user = userEvent.setup();
    api.messages.mockResolvedValue([assistantMessage()]);
    await boot("/c/a1b2");
    await user.type(screen.getByRole("textbox", { name: "消息输入" }), " next ");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("a1b2", { text: "next" }));
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g-live", expect.any(Function)));

    window.history.pushState({}, "", "/");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await screen.findByRole("heading", { name: "默认助手" })).toBeInTheDocument();
  });

  it("sends, retries, selects a generation, copies, and cancels", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const old = generation({ id: "g0", version: 1, blocks: [{ id: "old", index: 0, type: "text", content: "old answer", complete: true }] });
    const running = generation({ id: "g1", version: 2, status: "running", blocks: [] });
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, running], "g1")]);
    await boot("/c/a1b2");
    expect(await screen.findByRole("button", { name: "取消生成" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    expect(api.cancel).toHaveBeenCalledWith("g1");
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, generation({ id: "g1", version: 2 })], "g1")]);
    act(() => state.streams.get("g1")?.({ type: "status", generationId: "g1", status: "completed" }));
    await waitFor(() => expect(state.unsubscribes.some((unsubscribe) => unsubscribe.mock.calls.length)).toBe(true));
    api.messages.mockResolvedValue([userMessage(), assistantMessage([old, generation({ id: "g1", version: 2 })], "g0")]);
    fireEvent.click(screen.getByTitle("上一版本"));
    await waitFor(() => expect(api.selectGeneration).toHaveBeenCalledWith("a1", "g0"));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("old answer");
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith("a1"));
  });

  it("applies live SSE updates and refreshes on terminal snapshots", async () => {
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "running", blocks: [] })])]);
    await boot("/c/a1b2");
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g1", expect.any(Function)));
    act(() => state.streams.get("g1")?.({ type: "block-delta", generationId: "g1", block: { id: "b", index: 0, type: "text", content: "streamed", complete: false } }));
    expect(await screen.findByTestId("markdown")).toHaveTextContent("streamed");
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "waiting-approval" })])]);
    act(() => state.streams.get("g1")?.({ type: "snapshot", generation: generation({ status: "waiting-approval" }) }));
    await waitFor(() => expect(api.conversations).toHaveBeenCalledTimes(2));
    expect(state.unsubscribes.some((unsubscribe) => unsubscribe.mock.calls.length)).toBe(true);
  });

  it("shows structured usage, valid cache rates, and the legacy total fallback", async () => {
    const messageWithUsage = (id: string, usage: GenerationDto["usage"]): MessageDto => ({
      ...assistantMessage([generation({ id: `g-${id}`, usage })]),
      id,
      activeGenerationId: `g-${id}`
    });
    api.messages.mockResolvedValue([
      messageWithUsage("positive", { inputTokens: 200, outputTokens: 40, cachedInputTokens: 84, totalTokens: 240 }),
      messageWithUsage("zero", { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120 }),
      messageWithUsage("missing", { inputTokens: 30, outputTokens: 4, totalTokens: 34 }),
      messageWithUsage("invalid", { inputTokens: 10, outputTokens: 2, cachedInputTokens: 11, totalTokens: 12 }),
      messageWithUsage("legacy", { totalTokens: 12 })
    ]);
    await boot("/c/a1b2");

    expect(await screen.findByText("缓存 42%")).toBeInTheDocument();
    expect(screen.getByText("缓存 0%")).toBeInTheDocument();
    expect(screen.getAllByText("输入 10")).toHaveLength(1);
    expect(screen.getAllByText("输出 2")).toHaveLength(1);
    expect(screen.getAllByText(/缓存 /)).toHaveLength(2);
    expect(screen.getByText("12 tokens")).toBeInTheDocument();
  });
  });
}

export function registerAppApprovalTests() {
  describe("App approvals and settings", () => {
    beforeEach(resetApi);
  it("approves and denies tools and resumes generation when requested", async () => {
    api.messages.mockResolvedValue([assistantMessage([generation({ status: "waiting-approval", toolCalls: [tool()] })])]);
    await boot("/c/a1b2");
    expect(await screen.findByTestId("markdown")).toHaveTextContent("answer");
    expect(screen.queryAllByRole("button", { name: /允许/ })).toHaveLength(1);
    expect(document.querySelector(".tool-call button")).toBeNull();
    const resumed = generation({ id: "g-resumed", status: "running", blocks: [], toolCalls: [tool()] });
    api.messages.mockResolvedValue([assistantMessage([resumed], "g-resumed")]);
    fireEvent.click(await screen.findByRole("button", { name: /允许/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t1", true));
    await waitFor(() => expect(generationEvents).toHaveBeenCalledWith("g-resumed", expect.any(Function)));
    api.approveTool.mockResolvedValueOnce({ toolCall: tool(), generationId: "g", resumed: false });
    fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t1", false));
  }, 120_000);

  it("shows pending tools in index order, preserves the draft, and restores Sender after the queue", async () => {
    const user = userEvent.setup();
    const first = tool({ id: "t-first", index: 1, arguments: '{"cmd":"pwd","path":"/tmp"}' });
    const second = tool({ id: "t-second", index: 2, name: "workspace_write", arguments: '{"content":"hello"}' });
    const waiting = generation({ id: "g-waiting", status: "waiting-approval", blocks: [], toolCalls: [second, first] });
    const nextWaiting = generation({ id: "g-waiting", status: "waiting-approval", blocks: [], toolCalls: [{ ...second }] });
    const resumed = generation({ id: "g-resumed", status: "running", blocks: [], toolCalls: [{ ...second, approvalState: "denied" }] });
    let messageState: MessageDto[] = [assistantMessage([waiting])];
    api.conversations.mockResolvedValue([{ ...conversation, draft: "keep this draft" }]);
    api.messages.mockImplementation(async () => messageState);
    api.approveTool
      .mockImplementationOnce(async () => {
        messageState = [assistantMessage([nextWaiting])];
        return { toolCall: { ...first, approvalState: "approved" }, generationId: "g-waiting", resumed: false };
      })
      .mockImplementationOnce(async () => {
        messageState = [assistantMessage([resumed], "g-resumed")];
        return { toolCall: { ...second, approvalState: "denied" }, generationId: "g-resumed", resumed: true };
      });
    await boot("/c/a1b2");

    const approval = await screen.findByRole("region", { name: "工具审批" });
    expect(screen.queryByRole("textbox", { name: "消息输入" })).not.toBeInTheDocument();
    expect(within(approval).getByText("工作区 / shell")).toBeInTheDocument();
    expect(within(approval).getByText("第 1 项，共 2 项")).toBeInTheDocument();
    expect(within(approval).getByText(/"cmd": "pwd"/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /允许/ })).toHaveLength(1);

    await user.click(within(approval).getByRole("button", { name: /允许/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t-first", true));
    const nextApproval = await screen.findByRole("region", { name: "工具审批" });
    await waitFor(() => expect(within(nextApproval).getByText("工作区 / write")).toBeInTheDocument());
    expect(within(nextApproval).getByText("第 1 项，共 1 项")).toBeInTheDocument();
    expect(within(nextApproval).getByText("工作区 / write")).toBeInTheDocument();

    await user.click(within(nextApproval).getByRole("button", { name: /拒绝/ }));
    await waitFor(() => expect(api.approveTool).toHaveBeenCalledWith("t-second", false));
    await waitFor(() => expect(screen.queryByRole("region", { name: "工具审批" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "消息输入" })).toHaveValue("keep this draft");
    expect(generationEvents).toHaveBeenCalledWith("g-resumed", expect.any(Function));
  });

  it("retains the approval item and shows the error when approval fails", async () => {
    const user = userEvent.setup();
    const waiting = generation({ status: "waiting-approval", blocks: [], toolCalls: [tool()] });
    api.messages.mockResolvedValue([assistantMessage([waiting])]);
    api.approveTool.mockRejectedValueOnce(new Error("approval failed"));
    await boot("/c/a1b2");
    const approval = await screen.findByRole("region", { name: "工具审批" });
    await user.click(within(approval).getByRole("button", { name: /允许/ }));
    expect(await screen.findByText("approval failed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "工具审批" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "工具审批" })).getByRole("button", { name: /允许/ })).toBeEnabled();
  });

  it("optimistically updates UI settings and keeps new-conversation reasoning local", async () => {
    await boot();
    let rejectUi!: (reason: Error) => void;
    api.updateSettings.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectUi = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(await screen.findByRole("button", { name: "打开会话栏" })).toBeInTheDocument();
    rejectUi(new Error("ui failed"));
    expect(await screen.findByText("ui failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "收起会话栏" })).toBeInTheDocument());

    fireEvent.change(screen.getAllByRole("combobox", { name: /推理:medium/ })[0]!, { target: { value: "high" } });
    expect(screen.getAllByRole("combobox", { name: /推理:high/ })[0]).toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("opens and closes settings and accepts settings callbacks on mobile", async () => {
    state.screens = { md: false, lg: false };
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "打开会话栏" }));
    const mobileSidebar = document.querySelector(".ant-drawer-left .sidebar-content") as HTMLElement;
    fireEvent.click(within(mobileSidebar).getByText("设置").closest("button")!);
    expect(await screen.findByTestId("settings-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改界面" }));
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ uiPreferences: { sidebarCollapsed: true, reasoningCollapsePolicy: "never-auto-collapse" } }));
    fireEvent.click(screen.getByRole("button", { name: "应用设置" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
  });
  });
}

export function registerAppOperationTests() {
  describe("App workspace and background tasks", () => {
    beforeEach(resetApi);

    it("browses hidden directories, recovers from creation errors, and binds the workspace", async () => {
      api.directories.mockResolvedValue({
        path: "/workspace", parentPath: "/",
        entries: [
          { name: ".hidden", path: "/workspace/.hidden", directory: true, hidden: true },
          { name: "project", path: "/workspace/project", directory: true, hidden: false }
        ]
      });
      await boot("/c/a1b2");
      fireEvent.click(screen.getByRole("button", { name: "选择工作目录" }));
      expect(await screen.findByRole("heading", { name: "选择工作目录" })).toBeInTheDocument();
      expect(screen.getByText("project")).toBeInTheDocument();
      expect(screen.queryByText(".hidden")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.getByText(".hidden")).toBeInTheDocument();

      api.createDirectory.mockRejectedValueOnce(new Error("cannot create directory"));
      fireEvent.change(screen.getByPlaceholderText("新目录名称"), { target: { value: "new-project" } });
      fireEvent.click(screen.getByRole("button", { name: "创建" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("cannot create directory");
      fireEvent.click(screen.getByRole("button", { name: "创建" }));
      await waitFor(() => expect(api.createDirectory).toHaveBeenLastCalledWith("/workspace/new-project"));
      await waitFor(() => expect(api.directories).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole("button", { name: "使用此目录" }));
      await waitFor(() => expect(api.updateConversation).toHaveBeenCalledWith("a1b2", { workspacePath: "/workspace" }));
      expect(api.updateSettings).toHaveBeenCalledWith({ lastWorkspacePath: "/workspace" });
      expect(screen.queryByRole("heading", { name: "选择工作目录" })).not.toBeInTheDocument();
    });

    it("pages retained output, exposes all task states, renders PTY output, and stops work", async () => {
      const running = backgroundTask();
      const failed = backgroundTask({ id: "task-failed", command: "failed command", status: "failed", outputCursor: 0, completedAt: 4, error: "failed" });
      const completed = backgroundTask({
        id: "task-completed", conversationId: "other", command: "completed command", mode: "pty", status: "completed",
        outputCursor: 3, completedAt: 5, exitCode: 0
      });
      const queued = backgroundTask({ id: "task-queued", command: "queued command", status: "queued", outputCursor: 0, startedAt: null });
      api.backgroundTasks.mockResolvedValue([running, failed, completed, queued]);
      api.backgroundOutput.mockImplementation(async (id: string, cursor: number) => {
        if (id === "task-running") return { task: running, cursor: cursor + 4, earliestCursor: 0, gap: false, raw: cursor ? "second" : "first", text: "", screen: null };
        return { task: completed, cursor: 3, earliestCursor: 0, gap: false, raw: "pty", text: "", screen: null };
      });
      api.backgroundTask.mockImplementation(async (id: string) => ({
        task: id === "task-completed" ? completed : running,
        events: id === "task-running" ? [{ id: 1, taskId: id, type: "state", reason: "started by agent", data: {}, createdAt: 1 }] : []
      }));
      api.stopBackgroundTask.mockResolvedValue({ ...running, status: "stopped" });

      await boot("/c/a1b2");
      fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
      expect(await screen.findByText("firstsecond")).toBeInTheDocument();
      expect(screen.getByText(/started by agent/)).toBeInTheDocument();
      expect(screen.getByText("failed command")).toBeInTheDocument();
      expect(screen.getByText("queued command")).toBeInTheDocument();
      expect(screen.queryByText("completed command")).not.toBeInTheDocument();
      expect(api.backgroundOutput).toHaveBeenNthCalledWith(1, "task-running", 0, 32 * 1024);
      expect(api.backgroundOutput).toHaveBeenNthCalledWith(2, "task-running", 4, 32 * 1024);

      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByText("completed command").closest("button")!);
      expect(await screen.findByTestId("task-terminal")).toHaveTextContent("pty");
      fireEvent.click(screen.getAllByText("npm test")[0]!.closest("button")!);
      fireEvent.click(screen.getByRole("button", { name: /停止/ }));
      await waitFor(() => expect(api.stopBackgroundTask).toHaveBeenCalledWith("task-running", "用户从任务抽屉停止"));
      await waitFor(() => expect(api.backgroundTasks).toHaveBeenCalledTimes(2));
    });
  });
}
