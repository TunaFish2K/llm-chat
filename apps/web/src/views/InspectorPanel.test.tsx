import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appStore } from "../lib/app-state";
import { makeAgent, makeBackgroundTask, makeConnection, makeConversation, makeGeneration, makeMessage, makeModel, makeSettings } from "../../test/fixtures";
import { InspectorPanel } from "./InspectorPanel";

function seed() {
  const conversation = makeConversation({ executionOverrides: { modelId: "model-1", reasoningEffort: "high" } });
  const generation = makeGeneration({
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 8, cachedInputTokens: 40, totalTokens: 120 },
    context: { policy: "trim", estimatedInputTokens: 100, omittedMessages: 2, summaryUsed: false }
  });
  appStore.set({
    auth: "ready",
    bootError: null,
    settings: makeSettings(),
    agents: [makeAgent()],
    connections: [makeConnection()],
    models: [makeModel()],
    conversations: [conversation],
    messages: { "conv-1": [makeMessage({ id: "assistant-1", activeGenerationId: generation.id, generations: [generation] })] },
    toasts: [],
    eventsConnectionState: "connected",
    runningTasksByConversation: {}
  });
  return { conversation, generation };
}

describe("InspectorPanel", () => {
  it("shows effective conversation configuration by default", () => {
    const { conversation } = seed();
    render(<InspectorPanel conversation={conversation} target={null} onClose={vi.fn()} />);
    expect(screen.getByText("GPT 测试")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/reasoningEffort/)).toBeInTheDocument();
  });

  it("shows persisted generation settings, context and usage", () => {
    const { conversation, generation } = seed();
    render(<InspectorPanel conversation={conversation} target={{ kind: "generation", messageId: "assistant-1", generationId: generation.id }} onClose={vi.fn()} />);
    expect(screen.getByText("生成 v1")).toBeInTheDocument();
    expect(screen.getByText("100 tokens")).toBeInTheDocument();
    expect(screen.getByText("20 tokens")).toBeInTheDocument();
    expect(screen.getByText("40 tokens（40%）")).toBeInTheDocument();
    expect(screen.getByText("上下文决策")).toBeInTheDocument();
    expect(screen.getByText("有效设置")).toBeInTheDocument();
  });

  it("opens task details inside the owning conversation", async () => {
    const { conversation } = seed();
    const task = makeBackgroundTask();
    window.history.pushState(null, "", "/c/conv-1");
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
      url === "/api/background-tasks/task-1" ? { task, events: [] } : { throughOrdinal: null }
    ), { status: 200, headers: { "content-type": "application/json" } }))));

    render(<InspectorPanel conversation={conversation} target={{ kind: "task", taskId: task.id }} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "在会话任务中打开" }));
    expect(window.location.pathname).toBe("/c/conv-1/tasks/task-1");
  });
});
