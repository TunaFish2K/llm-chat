import type { ConnectionDto, ModelDto, ProviderProtocol } from "@llm-chat/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { isModelUsable, ModelSelector, protocolShortName } from "./ModelSelector";

const connection = (id: string, name: string, protocol: ProviderProtocol): ConnectionDto => ({
  id, name, protocol, baseUrl: "https://example.com", hasApiKey: true, secretHeaderNames: [], createdAt: 1, updatedAt: 1
});

const model = (id: string, connectionId: string, displayName: string, modelKey: string, enabled = true): ModelDto => ({
  id, connectionId, displayName, modelKey, enabled, source: "manual", contextWindow: 1000, maxOutputTokens: 100,
  capabilities: { tools: true, temperature: true, topP: true, reasoning: true, reasoningSummary: true, adaptiveThinking: false, manualThinking: false },
  defaultSettings: { common: { maxOutputTokens: 100, stopSequences: [] }, protocol: {} }, createdAt: 1, updatedAt: 1
});

const connections = [
  connection("c1", "Primary", "openai-responses"),
  connection("c2", "Claude", "anthropic-messages")
];
const models = [
  model("m1", "c1", "GPT Alpha", "gpt-alpha"),
  model("m2", "c1", "GPT Beta", "gpt-beta", false),
  model("m3", "c2", "Sonnet", "claude-sonnet")
];

function renderSelector(overrides: Partial<React.ComponentProps<typeof ModelSelector>> = {}) {
  const props = {
    value: "m1",
    models,
    connections,
    onChange: vi.fn(),
    onGoSettings: vi.fn(),
    ...overrides
  };
  render(<ModelSelector {...props} />);
  return props;
}

describe("ModelSelector", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formats protocol names and determines model usability", () => {
    expect(protocolShortName("openai-responses")).toBe("Responses");
    expect(protocolShortName("openai-chat")).toBe("Chat");
    expect(protocolShortName("anthropic-messages")).toBe("Anthropic");
    expect(isModelUsable(models[0], connections)).toBe(true);
    expect(isModelUsable(models[1], connections)).toBe(false);
    expect(isModelUsable(model("orphan", "gone", "Gone", "gone"), connections)).toBe(false);
    expect(isModelUsable(null, connections)).toBe(false);
  });

  it("opens with the keyboard, groups eligible models, and selects one", async () => {
    const user = userEvent.setup();
    const props = renderSelector();
    const trigger = screen.getByRole("button", { name: "选择模型" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByPlaceholderText("搜索模型、连接或协议")).toHaveFocus();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GPT Alpha/ })).toBeInTheDocument();
    expect(screen.queryByText("GPT Beta")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(props.onChange).toHaveBeenCalledWith("m3");
    await waitFor(() => expect(trigger).not.toHaveClass("ant-popover-open"));
  });

  it("searches by model key, connection, and protocol and clears after close", async () => {
    const user = userEvent.setup();
    renderSelector();
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    const search = await screen.findByPlaceholderText("搜索模型、连接或协议");
    await user.type(search, "sonnet");
    const popup = screen.getByRole("tooltip");
    expect(within(popup).getByText("Sonnet")).toBeInTheDocument();
    expect(within(popup).queryByText("GPT Alpha")).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "OPENAI-RESPONSES");
    expect(within(popup).getByText("GPT Alpha")).toBeInTheDocument();
    await user.click(within(popup).getByRole("button", { name: /GPT Alpha/ }));
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    expect(await screen.findByPlaceholderText("搜索模型、连接或协议")).toHaveValue("");
  });

  it("shows an empty result and routes to model settings", async () => {
    const user = userEvent.setup();
    const props = renderSelector();
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.type(await screen.findByPlaceholderText("搜索模型、连接或协议"), "missing");
    expect(screen.getByText("没有匹配的模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /管理模型/ }));
    expect(props.onGoSettings).toHaveBeenCalledOnce();
  });

  it("renders unselected, invalid, and empty trigger states", () => {
    const { rerender } = render(<ModelSelector value={null} models={models} connections={connections} onChange={vi.fn()} onGoSettings={vi.fn()} />);
    expect(within(screen.getByRole("button", { name: "选择模型" })).getByText("选择模型")).toBeVisible();
    rerender(<ModelSelector value="missing" models={models} connections={connections} onChange={vi.fn()} onGoSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: "选择模型" })).toHaveClass("ant-btn-dangerous");
    expect(screen.getByText("选择模型")).toHaveClass("ant-typography-danger");
    rerender(<ModelSelector value={null} models={[]} connections={[]} onChange={vi.fn()} onGoSettings={vi.fn()} />);
    expect(screen.getByText("暂无模型")).toBeVisible();
  });

  it("fetches enabled grouped balances only while open and formats the result", async () => {
    const user = userEvent.setup();
    const balanceConnections: ConnectionDto[] = [
      { ...connections[0]!, balanceConfig: { enabled: true, apiPath: "/credits", resultExpression: "data.value" } },
      { ...connections[1]!, balanceConfig: { enabled: false, apiPath: "/credits", resultExpression: "data.value" } },
      { ...connection("c3", "No models", "openai-chat"), balanceConfig: { enabled: true, apiPath: "/credits", resultExpression: "data.value" } }
    ];
    const balance = 12_345.67891;
    const request = vi.spyOn(api, "connectionBalance").mockResolvedValue({ connectionId: "c1", value: balance, fetchedAt: 1, cached: false });
    renderSelector({ connections: balanceConnections });

    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("c1");
    const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(balance);
    expect(await screen.findByLabelText(`账户余额 ${formatted}`)).toBeInTheDocument();
  });

  it("isolates balance failures from search and model selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const balanceConnections = connections.map((item) => ({
      ...item,
      balanceConfig: { enabled: true, apiPath: "/credits", resultExpression: "data.value" }
    }));
    vi.spyOn(api, "connectionBalance").mockImplementation(async (id) => {
      if (id === "c1") throw Object.assign(new Error("安全的余额错误"), { code: "balance_failed" });
      return { connectionId: id, value: 9, fetchedAt: 1, cached: false };
    });
    renderSelector({ connections: balanceConnections, onChange });

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    expect(await screen.findByLabelText("账户余额获取失败")).toBeInTheDocument();
    expect(await screen.findByLabelText("账户余额 9")).toBeInTheDocument();
    const search = screen.getByPlaceholderText("搜索模型、连接或协议");
    await user.type(search, "sonnet");
    await user.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(onChange).toHaveBeenCalledWith("m3");
  });

  it("ignores a stale balance response after the selector is reopened", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: Awaited<ReturnType<typeof api.connectionBalance>>) => void;
    const first = new Promise<Awaited<ReturnType<typeof api.connectionBalance>>>((resolve) => { resolveFirst = resolve; });
    const request = vi.spyOn(api, "connectionBalance")
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ connectionId: "c1", value: 2, fetchedAt: 2, cached: false });
    const enabled = [{ ...connections[0]!, balanceConfig: { enabled: true, apiPath: "/credits", resultExpression: "data.value" } }];
    const { unmount } = render(<ModelSelector value="m1" models={[models[0]!]} connections={enabled} onChange={vi.fn()} onGoSettings={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "选择模型" });

    await user.click(trigger);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await user.click(trigger);
    await user.click(trigger);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("账户余额 2")).toBeInTheDocument();
    await act(async () => resolveFirst({ connectionId: "c1", value: 1, fetchedAt: 1, cached: false }));
    expect(screen.queryByLabelText("账户余额 1")).not.toBeInTheDocument();
    unmount();
  });
});
