import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto } from "@llm-chat/contracts";
import { appStore } from "../lib/app-state";
import { readComposerDraft, writeComposerDraft } from "../lib/composer-drafts";
import { endpoints } from "../lib/api";
import { ChatView } from "./ChatView";
import { imageRetryMessages, makeImageJob } from "../../test/image-tool-fixtures";
import { offlineStore } from "../lib/offline-history";
import {
  makeAgent,
  makeConnection,
  makeConversation,
  makeGeneration,
  makeMessage,
  makeModel,
  makeSettings
} from "../../test/fixtures";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function seedStore(messages: MessageDto[] = [], options: { draft?: string; models?: ReturnType<typeof makeModel>[]; conversation?: ReturnType<typeof makeConversation> } = {}) {
  appStore.set({
    auth: "ready",
    bootError: null,
    settings: makeSettings(),
    agents: [makeAgent()],
    connections: [makeConnection()],
    models: options.models ?? [makeModel()],
    conversations: [options.conversation ?? makeConversation({ draft: options.draft ?? "" })],
    messages: { "conv-1": messages },
    toasts: [],
    eventsConnectionState: "connected",
    runningTasksByConversation: {}
  });
}

function messageFetch(messages: MessageDto[]) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/queue")) return Promise.resolve(json({ items: [], paused: false }));
    if (url.endsWith("/queued-messages")) return Promise.resolve(json([]));
    if (url === "/api/conversations/conv-1/messages" && (!init || init.method === "GET")) return Promise.resolve(json(messages));
    return Promise.resolve(json({ error: { code: "unexpected", message: `unexpected ${url}` } }, 500));
  });
}

beforeEach(() => {
  window.history.pushState(null, "", "/");
  vi.spyOn(endpoints, "queueState").mockResolvedValue({ items: [], paused: false });
  vi.spyOn(endpoints, "agents").mockImplementation(async () => appStore.get().agents);
});

describe("ChatView", () => {
  it("projects image retries into the answer and hides inactive-version jobs during offline version selection", async () => {
    const messages = imageRetryMessages();
    const reply = messages[1]!;
    reply.generations.push(makeGeneration({ id: "gen-2", version: 2, blocks: [{ id: "alternate", stepIndex: 0, index: 0, type: "text", content: "另一版回答", complete: true }] }));
    messages.push(makeMessage({ id: "standalone", ordinal: 6, imageGenerationJob: makeImageJob({ toolCallId: null, error: { code: "failed", message: "独立任务失败" } }) }));
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));
    const { container } = render(<ChatView conversationId="conv-1" />);
    await waitFor(() => expect(container.querySelectorAll(".msg")).toHaveLength(3));
    const errors = screen.getAllByRole("alert");
    expect(errors).toHaveLength(3);
    expect(errors[0]!.compareDocumentPosition(screen.getByText("第一次重试")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(errors[1]!.compareDocumentPosition(screen.getByText("第二次重试")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("img", { name: "beach.png" }).compareDocumentPosition(screen.getByText("海滩已画好")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => offlineStore.set({ offline: true }));
    fireEvent.click(screen.getByRole("button", { name: "下一版本" }));
    expect(screen.getByText("另一版回答")).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("独立任务失败");
    expect(screen.queryByRole("img", { name: "beach.png" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "上一版本" }));
    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(screen.getByRole("img", { name: "beach.png" })).toBeVisible();
    expect(appStore.get().messages["conv-1"]).toHaveLength(messages.length);
  });

  it("uses the remembered model when a new draft resets to follow its Agent", async () => {
    seedStore([], { models: [makeModel(), makeModel({ id: "model-2", displayName: "Second" })] });
    const agent = makeAgent();
    appStore.set({ agents: [{ ...agent, modelId: null, execution: { ...agent.execution, modelId: null }, lastSelectedModelId: "model-1" }] });
    writeComposerDraft(null, { text: "draft", attachments: [], agentId: agent.id, overrides: { modelId: "model-2" }, workspace: null, greetingIndex: 0 });
    vi.stubGlobal("fetch", messageFetch([]));
    const select = vi.spyOn(endpoints, "selectAgentModel");
    const user = userEvent.setup(); render(<ChatView conversationId={null} />);
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.click(screen.getByText("跟随 Agent", { exact: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", makeModel().displayName));
    expect(select).not.toHaveBeenCalled();
  });

  it("waits for the chosen model to save before enabling send", async () => {
    seedStore([], { models: [makeModel(), makeModel({ id: "model-2", displayName: "Second" })] });
    const updated = makeConversation({ modelId: "model-2", executionOverrides: { modelId: "model-2" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/conversations") return json([updated]);
      if (url.endsWith("/messages")) return json([]);
      return json({});
    }));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(endpoints, "updateConversation").mockImplementation(async (_, patch) => {
      if (patch.modelId) await pending;
      return updated;
    });
    const user = userEvent.setup(); render(<ChatView conversationId="conv-1" />);
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "next turn" } });
    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.getByRole("button", { name: /^发送$/ })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: /^发送$/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "Second");
  });

  it("keeps an unsent draft when the first send fails", async () => {
    seedStore(); vi.stubGlobal("fetch", messageFetch([]));
    vi.spyOn(endpoints, "startConversation").mockRejectedValue(new Error("发送失败测试"));
    const user = userEvent.setup();
    const first = render(<ChatView conversationId={null} />);
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "失败后保留" } });
    await user.click(screen.getByRole("button", { name: /^发送$/ }));
    await waitFor(() => expect(appStore.get().toasts.some((item) => item.text === "发送失败测试")).toBe(true));
    first.unmount();
    render(<ChatView conversationId={null} />);
    expect(screen.getByLabelText("输入消息")).toHaveValue("失败后保留");
  });

  it("restores text and attachments after unmounting, keeping branches isolated", () => {
    seedStore(); vi.stubGlobal("fetch", messageFetch([]));
    writeComposerDraft("conv-1", { text: "恢复草稿", attachments: [{ id: "asset", fileName: "draft.txt", mimeType: "text/plain", kind: "file", byteSize: 1, sha256: "hash", url: "/api/files/asset", createdAt: 1 }], agentId: "agent-1", overrides: {}, workspace: null, greetingIndex: 0 });
    const first = render(<ChatView conversationId="conv-1" />);
    expect(screen.getByLabelText("输入消息")).toHaveValue("恢复草稿");
    expect(screen.getByLabelText("待发送附件")).toHaveTextContent("draft.txt");
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "最新草稿" } });
    first.unmount();
    const other = render(<ChatView conversationId={null} />);
    expect(screen.getByLabelText("输入消息")).toHaveValue(""); other.unmount();
    render(<ChatView conversationId="conv-1" />);
    expect(screen.getByLabelText("输入消息")).toHaveValue("最新草稿");
    expect(screen.getByLabelText("待发送附件")).toHaveTextContent("draft.txt");
  });

  it("does not pin an untouched blank chat to an old remembered model", () => {
    seedStore([], { models: [makeModel(), makeModel({ id: "model-2", displayName: "Second" })] });
    const agent = makeAgent();
    appStore.set({ agents: [{ ...agent, modelId: null, execution: { ...agent.execution, modelId: null }, lastSelectedModelId: "model-1" }] });
    vi.stubGlobal("fetch", messageFetch([]));
    const first = render(<ChatView conversationId={null} />);
    expect(screen.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", makeModel().displayName);
    first.unmount();
    expect(readComposerDraft(null)?.overrides).not.toHaveProperty("modelId");
    appStore.set({ agents: [{ ...agent, modelId: null, execution: { ...agent.execution, modelId: null }, lastSelectedModelId: "model-2" }] });
    const second = render(<ChatView conversationId={null} />);
    expect(screen.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "Second");
    fireEvent.change(screen.getByLabelText("输入消息"), { target: { value: "draft pins this choice" } });
    second.unmount();
    appStore.set({ agents: [{ ...agent, modelId: null, execution: { ...agent.execution, modelId: null }, lastSelectedModelId: "model-1" }] });
    render(<ChatView conversationId={null} />);
    expect(screen.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "Second");
    expect(screen.getByLabelText("输入消息")).toHaveValue("draft pins this choice");
  });

  it("confirms a different Agent for existing messages and leaves the current selection untouched", async () => {
    const messages = [makeMessage({ role: "user", text: "保留历史" })];
    seedStore(messages);
    appStore.set({ agents: [makeAgent(), makeAgent({ id: "second", name: "第二助手" })] });
    const updated = makeConversation({ agentId: "second", executionOverrides: {} });
    const patch = vi.fn();
    const fallback = messageFetch(messages);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1" && init?.method === "PATCH") {
        patch(JSON.parse(init.body as string));
        return Promise.resolve(json(updated));
      }
      if (url === "/api/conversations") return Promise.resolve(json([updated]));
      return fallback(url, init);
    }));
    const user = userEvent.setup();
    render(<ChatView conversationId="conv-1" />);
    const trigger = screen.getByRole("button", { name: "选择 Agent" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "测试助手" }));
    expect(screen.queryByRole("dialog", { name: "切换 Agent" })).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "第二助手" }));
    expect(screen.getByRole("dialog", { name: "切换 Agent" })).toHaveTextContent("覆盖将全部清除");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(trigger).toHaveAttribute("title", "测试助手");
    expect(patch).not.toHaveBeenCalled();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "第二助手" }));
    await user.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(trigger).toHaveAttribute("title", "第二助手"));
    expect(patch).toHaveBeenCalledExactlyOnceWith({ agentId: "second" });
    expect(screen.getByText("保留历史")).toBeInTheDocument();
  });

  it("renders legacy user messages that omit attachments", async () => {
    const { attachments: _attachments, ...legacyMessage } = makeMessage({ role: "user", text: "旧消息仍可显示" });
    const messages = [legacyMessage as MessageDto];
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));

    render(<ChatView conversationId="conv-1" />);

    expect(screen.getByText("旧消息仍可显示")).toBeInTheDocument();
    await waitFor(() => expect(appStore.get().messages["conv-1"]?.[0]?.attachments).toEqual([]));
  });

  it("shows the current conversation task count in the top bar", async () => {
    seedStore([]);
    appStore.set({ runningTasksByConversation: { "conv-1": 2, "conv-2": 7 } });
    vi.stubGlobal("fetch", messageFetch([]));
    const onViewChange = vi.fn();

    render(<ChatView conversationId="conv-1" onViewChange={onViewChange} />);

    const tasksButton = screen.getByRole("button", { name: "打开后台任务，2 个运行中" });
    fireEvent.click(tasksButton);
    expect(onViewChange).toHaveBeenCalledWith("tasks");
    expect(screen.queryByRole("tab", { name: /对话/ })).not.toBeInTheDocument();
  });

  it("closes an active trajectory overlay from the same top-bar control", async () => {
    seedStore([]);
    vi.stubGlobal("fetch", messageFetch([]));
    const onViewChange = vi.fn();

    render(<ChatView conversationId="conv-1" view="trajectory" onViewChange={onViewChange} />);

    expect(await screen.findByRole("region", { name: "运行轨迹" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭运行轨迹" }));
    expect(onViewChange).toHaveBeenCalledWith("chat");
  });

  it("renders reasoning, answer, model snapshot and token usage", async () => {
    const messages = [
      makeMessage({ id: "m-user", role: "user", text: "你好", createdAt: 1 }),
      makeMessage({
        id: "m-assistant",
        role: "assistant",
        activeGenerationId: "gen-1",
        generatedModel: {
          modelId: "model-1",
          displayName: "GPT 测试",
          modelKey: "gpt-test",
          connectionName: "测试连接",
          protocol: "openai-chat"
        },
        generations: [makeGeneration({
          blocks: [
            { id: "b1", index: 0, stepIndex: 0, type: "reasoning", content: "思考中…", complete: true },
            { id: "b2", index: 1, stepIndex: 0, type: "text", content: "你好，主人！", complete: true }
          ],
          usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 }
        })]
      })
    ];
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));

    render(<ChatView conversationId="conv-1" />);

    expect(await screen.findByText("你好，主人！")).toBeInTheDocument();
    expect(screen.getByText(/测试连接 \/ GPT 测试/)).toBeInTheDocument();
    expect(screen.getByText("↑ 12")).toBeInTheDocument();
    expect(screen.getByText("↓ 34")).toBeInTheDocument();
    expect(screen.getByText("推理过程")).toBeInTheDocument();
    expect(screen.getByText("思考中…")).not.toBeVisible();
  });

  it("renders refusal blocks as alerts", async () => {
    const messages = [makeMessage({
      activeGenerationId: "gen-1",
      generations: [makeGeneration({ blocks: [{ id: "b1", index: 0, stepIndex: 0, type: "refusal", content: "无法回答该问题", complete: true }] })]
    })];
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));
    render(<ChatView conversationId="conv-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("模型拒绝回答");
    expect(screen.getByRole("alert")).toHaveTextContent("无法回答该问题");
  });

  it("shows first-token feedback and preserves reading position during streaming", async () => {
    const generation = makeGeneration({ id: "gen-live", status: "running", blocks: [] });
    const messages = [makeMessage({ id: "m-live", activeGenerationId: generation.id, generations: [generation] })];
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));
    const { container } = render(<ChatView conversationId="conv-1" />);

    expect(await screen.findByText("正在生成")).toBeInTheDocument();
    const scroll = container.querySelector<HTMLElement>(".chat-scroll")!;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 800, writable: true }
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scroll, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.scroll(scroll);
    scroll.scrollTop = 799;
    fireEvent.scroll(scroll);
    expect(await screen.findByRole("button", { name: "回到最新消息" })).toBeVisible();

    const updated = [{
      ...messages[0]!,
      generations: [{
        ...generation,
        blocks: [{ id: "answer", index: 0, stepIndex: 0, type: "text" as const, content: "新的流式内容", complete: false }]
      }]
    }];
    appStore.set({ messages: { "conv-1": updated } });
    expect(await screen.findByText("新的流式内容")).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroll.scrollTop).toBe(799);

    fireEvent.click(screen.getByRole("button", { name: "回到最新消息" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_200, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: "回到最新消息" })).not.toBeInTheDocument();
  });

  it("interleaves collapsed tool calls with generation steps", async () => {
    const generation = makeGeneration({
      blocks: [
        { id: "before", index: 1, stepIndex: 0, type: "reasoning", content: "先思考", complete: true },
        { id: "after", index: 1001, stepIndex: 1, type: "text", content: "工具后的回答", complete: true }
      ],
      toolCalls: [{
        id: "call-middle", index: 0, stepIndex: 0, name: "workspace_shell", arguments: '{"command":"fastfetch"}',
        approvalState: "completed", requiresApproval: false, output: "machine output", error: null,
        startedAt: 2, completedAt: 3, artifacts: []
      }]
    });
    const messages = [makeMessage({ activeGenerationId: generation.id, generations: [generation] })];
    seedStore(messages);
    vi.stubGlobal("fetch", messageFetch(messages));
    render(<ChatView conversationId="conv-1" />);

    const tool = await screen.findByText("workspace_shell");
    const details = tool.closest("details")!;
    const answer = screen.getByText("工具后的回答").closest(".markdown")!;
    expect(details.open).toBe(false);
    expect(details.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("resolves approvals in the composer and restores the saved draft", async () => {
    const user = userEvent.setup();
    const pending = makeMessage({
      id: "m-assistant",
      activeGenerationId: "gen-1",
      generations: [makeGeneration({
        status: "waiting-approval",
        toolCalls: [{
          id: "call-1",
          index: 0,
          stepIndex: 0,
          name: "shell",
          arguments: '{"command":"ls"}',
          approvalState: "pending",
          requiresApproval: true,
          output: null,
          error: null,
          startedAt: null,
          completedAt: null,
          artifacts: []
        }]
      })]
    });
    const resolved = [{ ...pending, generations: [{ ...pending.generations[0]!, status: "running" as const, toolCalls: [{ ...pending.generations[0]!.toolCalls[0]!, approvalState: "approved" as const }] }] }];
    seedStore([pending], { draft: "不要丢掉这段草稿" });
    let approved = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/tool-calls/call-1/approval" && init?.method === "POST") {
        approved = true;
        return Promise.resolve(json({ toolCall: {}, generationId: "gen-1", resumed: true }));
      }
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(approved ? resolved : [pending]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "允许" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/tool-calls/call-1/approval",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ approved: true }) })
    ));
    expect(await screen.findByLabelText("输入消息")).toHaveValue("不要丢掉这段草稿");
  });

  it("switches generation versions through the API", async () => {
    const user = userEvent.setup();
    const gen1 = makeGeneration({ id: "gen-1", version: 1 });
    const gen2 = makeGeneration({ id: "gen-2", version: 2, blocks: [{ id: "b9", index: 0, stepIndex: 0, type: "text", content: "第二版回答", complete: true }] });
    const messages = [makeMessage({ id: "m-assistant", activeGenerationId: "gen-1", generations: [gen1, gen2] })];
    seedStore(messages);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/messages/m-assistant/active-generation" && init?.method === "PATCH") return Promise.resolve(json({ ok: true }));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(messages));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "下一版本" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/m-assistant/active-generation",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ generationId: "gen-2" }) })
    ));
  });

  it("sends a message in an existing conversation", async () => {
    const user = userEvent.setup();
    seedStore([]);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/messages" && init?.method === "POST") return Promise.resolve(json({ userMessageId: "u", assistantMessageId: "a", generationId: "g" }, 202));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json([]));
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation()]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.type(screen.getByLabelText("输入消息"), "测试消息");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/messages",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "测试消息" }) })
    ));
  });

  it("uploads and sends a pure image message when the model accepts images", async () => {
    const user = userEvent.setup();
    const model = makeModel({ capabilities: { ...makeModel().capabilities, imageInput: true } });
    seedStore([], { models: [model] });
    const asset = {
      id: "00000000-0000-4000-8000-000000000009",
      fileName: "pixel.png",
      mimeType: "image/png" as const,
      byteSize: 8,
      sha256: "b".repeat(64),
      url: `/api/images/00000000-0000-4000-8000-000000000009?v=${"b".repeat(64)}`,
      createdAt: 1
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/images" && init?.method === "POST") return Promise.resolve(json(asset, 201));
      if (url === "/api/conversations/conv-1/messages" && init?.method === "POST") {
        return Promise.resolve(json({ userMessageId: "u", assistantMessageId: "a", generationId: "g" }, 202));
      }
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json([]));
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation()]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ChatView conversationId="conv-1" />);
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "pixel.png", { type: "image/png" });

    await user.upload(container.querySelector('input[type="file"]')!, file);
    expect(await screen.findByRole("img", { name: "pixel.png" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "", assetIds: [asset.id] })
      })
    ));
  });

  it("edits a user message by creating a branch and immediately generating", async () => {
    const user = userEvent.setup();
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      id: `file-${index}`,
      fileName: `document-${index}.txt`,
      mimeType: "text/plain",
      kind: "file" as const,
      byteSize: 10,
      sha256: `${index}`.repeat(64),
      url: `/api/files/file-${index}?v=${`${index}`.repeat(64)}`,
      createdAt: 1
    }));
    const messages = [
      makeMessage({ id: "user-1", ordinal: 1, role: "user", text: "原问题", attachments, createdAt: 1 }),
      makeMessage({ id: "assistant-1", ordinal: 2, role: "assistant", activeGenerationId: "gen-1", generations: [makeGeneration()] })
    ];
    const branch = makeConversation({ id: "conv-branch", forkedFrom: {
      conversationId: "conv-1", messageId: "user-1", messageOrdinal: 1, mode: "edit",
      greetingIndex: null, sourceGreetingIndex: null
    } });
    seedStore(messages);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/forks" && init?.method === "POST") return Promise.resolve(json({
        conversation: branch,
        generation: { userMessageId: "user-edited", assistantMessageId: "assistant-new", generationId: "gen-new" }
      }, 202));
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation(), branch]));
      if (url === "/api/conversations/conv-branch/messages") return Promise.resolve(json([]));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(messages));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "编辑并分叉" }));
    const input = screen.getByLabelText("修改后的消息");
    await user.clear(input);
    await user.type(input, "修改后的问题");
    await user.click(screen.getByRole("button", { name: "创建分支并生成" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/forks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          mode: "edit",
          messageId: "user-1",
          text: "修改后的问题",
          assetIds: attachments.map((asset) => asset.id)
        })
      })
    ));
    await waitFor(() => expect(window.location.pathname).toBe("/c/conv-branch"));
  });

  it("continues from an assistant message in a new branch", async () => {
    const user = userEvent.setup();
    const messages = [
      makeMessage({ id: "user-1", ordinal: 1, role: "user", text: "问题", createdAt: 1 }),
      makeMessage({ id: "assistant-1", ordinal: 2, role: "assistant", activeGenerationId: "gen-1", generations: [makeGeneration()] })
    ];
    const branch = makeConversation({ id: "conv-branch", forkedFrom: {
      conversationId: "conv-1", messageId: "assistant-1", messageOrdinal: 2, mode: "continue",
      greetingIndex: null, sourceGreetingIndex: null
    } });
    seedStore(messages);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/forks" && init?.method === "POST") return Promise.resolve(json({ conversation: branch, generation: null }, 201));
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation(), branch]));
      if (url === "/api/conversations/conv-branch/messages") return Promise.resolve(json(messages));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(messages));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "从此处继续" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/forks",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "continue", throughMessageId: "assistant-1" }) })
    ));
  });

  it("switches persisted branches from the source message", async () => {
    const user = userEvent.setup();
    const root = makeConversation({ id: "conv-1", title: "根会话" });
    const first = makeConversation({ id: "branch-1", createdAt: 2, forkedFrom: {
      conversationId: root.id, messageId: "assistant-1", messageOrdinal: 2, mode: "continue",
      greetingIndex: null, sourceGreetingIndex: null
    } });
    const second = makeConversation({ id: "branch-2", createdAt: 3, forkedFrom: {
      conversationId: root.id, messageId: "assistant-1", messageOrdinal: 2, mode: "continue",
      greetingIndex: null, sourceGreetingIndex: null
    } });
    const messages = [
      makeMessage({ id: "user-1", ordinal: 1, role: "user", text: "问题", createdAt: 1 }),
      makeMessage({
        id: "assistant-1",
        ordinal: 2,
        role: "assistant",
        activeGenerationId: "gen-1",
        generations: [makeGeneration()]
      })
    ];
    seedStore(messages, { conversation: root });
    appStore.set({ conversations: [root, second, first] });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/active-branch" && init?.method === "PATCH") {
        return Promise.resolve(json({ activeBranchId: "branch-1" }));
      }
      if (url === "/api/conversations") return Promise.resolve(json([root, second, first]));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(messages));
      return Promise.resolve(json({ error: { code: "unexpected", message: `unexpected ${url}` } }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    expect(await screen.findByLabelText("对话分支切换")).toHaveTextContent("1 / 3");
    expect(screen.queryByRole("button", { name: /分叉自/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一分支" }));
    await waitFor(() => expect(window.location.pathname).toBe("/c/branch-1"));
  });

  it("switches a persisted greeting by creating a root branch", async () => {
    const user = userEvent.setup();
    const greeting = makeMessage({
      id: "greeting-1",
      text: "第一条开场白",
      greeting: {
        variants: ["第一条开场白", "第二条开场白"],
        activeIndex: 0,
        agent: { agentId: "agent-1", name: "测试助手", revision: 1 }
      }
    });
    const branch = makeConversation({
      id: "conv-greeting",
      forkedFrom: {
        conversationId: "conv-1", messageId: greeting.id, messageOrdinal: 1, mode: "greeting",
        greetingIndex: 1, sourceGreetingIndex: 0
      }
    });
    seedStore([greeting]);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/forks" && init?.method === "POST") {
        return Promise.resolve(json({ conversation: branch, generation: null }, 201));
      }
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation(), branch]));
      if (url === "/api/conversations/conv-greeting/messages") return Promise.resolve(json([]));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json([greeting]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "下一条开场白" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/forks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ mode: "greeting", messageId: "greeting-1", greetingIndex: 1 })
      })
    ));
    await waitFor(() => expect(window.location.pathname).toBe("/c/conv-greeting"));
  });

  it("reuses an existing greeting branch instead of creating a duplicate", async () => {
    const user = userEvent.setup();
    const greeting = makeMessage({
      id: "greeting-1",
      ordinal: 1,
      text: "第一条开场白",
      greeting: {
        variants: ["第一条开场白", "第二条开场白"],
        activeIndex: 0,
        agent: { agentId: "agent-1", name: "测试助手", revision: 1 }
      }
    });
    const root = makeConversation({ id: "conv-1" });
    const branch = makeConversation({
      id: "conv-greeting",
      forkedFrom: {
        conversationId: root.id,
        messageId: greeting.id,
        messageOrdinal: 1,
        mode: "greeting",
        greetingIndex: 1,
        sourceGreetingIndex: 0
      }
    });
    seedStore([greeting], { conversation: root });
    appStore.set({ conversations: [root, branch] });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/active-branch" && init?.method === "PATCH") {
        return Promise.resolve(json({ activeBranchId: branch.id }));
      }
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json([greeting]));
      if (url === "/api/conversations") return Promise.resolve(json([root, branch]));
      return Promise.resolve(json({ error: { code: "unexpected", message: `unexpected ${url}` } }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "下一条开场白" }));
    await waitFor(() => expect(window.location.pathname).toBe("/c/conv-greeting"));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      url === "/api/conversations/conv-1/forks" && (init as RequestInit | undefined)?.method === "POST"
    )).toBe(false);
  });

  it("manually creates a context summary checkpoint", async () => {
    const user = userEvent.setup();
    const messages = [1, 2, 3].flatMap((ordinal) => [
      makeMessage({ id: `user-${ordinal}`, role: "user", text: `问题 ${ordinal}`, createdAt: ordinal * 2 - 1 }),
      makeMessage({ id: `assistant-${ordinal}`, role: "assistant", activeGenerationId: `gen-${ordinal}`, generations: [makeGeneration({ id: `gen-${ordinal}` })], createdAt: ordinal * 2 })
    ]);
    seedStore(messages, { conversation: makeConversation({ contextPolicy: "auto" }) });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1/context/compact" && init?.method === "POST") return Promise.resolve(json({
        id: "summary-1", conversationId: "conv-1", throughOrdinal: 2, text: "摘要", connectionId: "connection-1",
        modelKey: "gpt-test", usage: { totalTokens: 12 }, createdAt: 10
      }));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json(messages));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(screen.getByRole("button", { name: "会话操作" }));
    await user.click(await screen.findByRole("button", { name: "立即压缩上下文" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1/context/compact",
      expect.objectContaining({ method: "POST", body: "{}" })
    ));
  });

  it("writes model selection to the current conversation override", async () => {
    const user = userEvent.setup();
    const models = [makeModel(), makeModel({ id: "model-2", modelKey: "claude-test", displayName: "Claude 测试" })];
    seedStore([], { models });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/conv-1" && init?.method === "PATCH") return Promise.resolve(json(makeConversation({ modelId: "model-2", executionOverrides: { modelId: "model-2" } })));
      if (url === "/api/conversations") return Promise.resolve(json([makeConversation({ modelId: "model-2", executionOverrides: { modelId: "model-2" } })]));
      if (url === "/api/conversations/conv-1/messages") return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId="conv-1" />);

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.click(await screen.findByRole("button", { name: /Claude 测试/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conv-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ modelId: "model-2" }) })
    ));
  });

  it("carries local model and reasoning choices into the first send", async () => {
    const user = userEvent.setup();
    const models = [makeModel(), makeModel({ id: "model-2", modelKey: "claude-test", displayName: "Claude 测试" })];
    seedStore([], { models });
    const createdConversation = makeConversation({ id: "conv-new", modelId: "model-2", executionOverrides: { modelId: "model-2", reasoningEffort: "high" } });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/conversations/start" && init?.method === "POST") return Promise.resolve(json({ conversation: createdConversation, generation: { userMessageId: "u", assistantMessageId: "a", generationId: "g" } }, 202));
      if (url === "/api/conversations") return Promise.resolve(json([createdConversation]));
      if (url === "/api/conversations/conv-new/messages") return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatView conversationId={null} />);

    await user.click(screen.getByRole("button", { name: "选择模型" }));
    await user.click(await screen.findByRole("button", { name: /Claude 测试/ }));
    await user.click(screen.getByRole("button", { name: /^推理档位：/ }));
    await user.click(screen.getByRole("button", { name: "high" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByLabelText("输入消息"), "第一条消息");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          text: "第一条消息",
          agentId: "agent-1",
          greetingIndex: 0,
          executionOverrides: { modelId: "model-2", reasoningEffort: "high" },
          workspacePath: null
        })
      })
    ));
  });

  it("uses the selected Agent identity on a new conversation", () => {
    seedStore([]);
    render(<ChatView conversationId={null} />);
    expect(document.querySelector(".greeting-preview .msg-identity strong")).toHaveTextContent("测试助手");
    expect(screen.getByText("你好！")).toBeInTheDocument();
  });
});
