import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageItem, type StreamCallbacks } from "./MessageStream";
import { makeGeneration, makeMessage, makeSettings } from "../../../test/fixtures";
import { appStore } from "../../lib/app-state";

const callbacks: StreamCallbacks = { onInspect: vi.fn(), onEdit: vi.fn(), onContinue: vi.fn(), onGreetingFork: vi.fn(), onBranchChange: vi.fn(), branching: false };
const reasoning = { id: "reasoning", stepIndex: 0, index: 0, type: "reasoning" as const, content: "Consider the question", complete: false };
const answer = { id: "answer", stepIndex: 1, index: 0, type: "text" as const, content: "The answer", complete: false };

function reply(generation: ReturnType<typeof makeGeneration>) {
  return <MessageItem conversationId="conv-1" message={makeMessage({ activeGenerationId: generation.id, generations: [generation] })} callbacks={callbacks} />;
}

describe("reply processing disclosure", () => {
  it("automatically collapses on prose while retaining a manual choice through streaming", () => {
    appStore.set({ settings: makeSettings() });
    const generation = makeGeneration({ status: "running", completedAt: null, blocks: [reasoning] });
    const { container, rerender } = render(reply(generation));
    expect(container.querySelector(".process-disclosure")).toHaveAttribute("open");
    rerender(reply({ ...generation, blocks: [{ ...reasoning, complete: true }, answer] }));
    expect(container.querySelector(".process-disclosure")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("处理完成"));
    expect(container.querySelector(".process-disclosure")).toHaveAttribute("open");
    rerender(reply({ ...generation, status: "completed", completedAt: 10, blocks: [{ ...reasoning, complete: true }, { ...answer, content: "The answer continues", complete: true }] }));
    expect(container.querySelector(".process-disclosure")).toHaveAttribute("open");
    expect(screen.getByText("Consider the question")).toBeVisible();
  });

  it.each(["always-collapsed", "never-auto-collapse"] as const)("honors %s for processing groups", (policy) => {
    const settings = makeSettings(); settings.uiPreferences.reasoningCollapsePolicy = policy;
    appStore.set({ settings });
    const { container } = render(reply(makeGeneration({ blocks: [{ ...reasoning, complete: true }, { ...answer, complete: true }] })));
    expect(container.querySelector(".process-disclosure")?.hasAttribute("open")).toBe(policy === "never-auto-collapse");
  });

  it("keeps tool errors visible while collapsed and stopped processing distinct from completion", () => {
    const settings = makeSettings(); settings.uiPreferences.reasoningCollapsePolicy = "always-collapsed";
    appStore.set({ settings });
    const tool = { id: "tool", stepIndex: 0, index: 0, name: "workspace_shell", arguments: "{}", approvalState: "failed" as const, requiresApproval: false, output: null, error: "Command failed", startedAt: 1, completedAt: 2, artifacts: [] };
    render(reply(makeGeneration({ status: "stopped", blocks: [reasoning], toolCalls: [tool] })));
    expect(screen.getByText("处理已停止")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Command failed");
  });
});
