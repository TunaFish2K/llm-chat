import { saveDisplayPreferences } from "../../lib/local-display";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImageGenerationJobDto } from "@llm-chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { MessageItem, type StreamCallbacks } from "./MessageStream";
import { makeGeneration, makeMessage, makeSettings } from "../../../test/fixtures";
import { appStore } from "../../lib/app-state";
import { endpoints } from "../../lib/api";
import { offlineStore } from "../../lib/offline-history";
import { imageRetryMessages, makeImageJob } from "../../../test/image-tool-fixtures";
import { projectImageJobs } from "./model";

const callbacks: StreamCallbacks = { onInspect: vi.fn(), onEdit: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn(), onGreetingFork: vi.fn(), onBranchChange: vi.fn(), branching: false };
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
    fireEvent.click(screen.getByText("推理过程"));
    expect(container.querySelector(".process-disclosure")).toHaveAttribute("open");
    const reasoningElement = screen.getByRole("region", { name: "推理内容" });
    rerender(reply({ ...generation, status: "completed", completedAt: 10, blocks: [{ ...reasoning, id: "persisted-reasoning", complete: true }, { ...answer, content: "The answer continues", complete: true }] }));
    expect(container.querySelector(".process-disclosure")).toHaveAttribute("open");
    expect(screen.getByText("Consider the question")).toBeVisible();
    expect(screen.getByRole("region", { name: "推理内容" })).toBe(reasoningElement);
  });

  it.each(["always-collapsed", "never-auto-collapse"] as const)("honors %s for processing groups", (policy) => {
    saveDisplayPreferences({ reasoningCollapsePolicy: policy });
    const { container } = render(reply(makeGeneration({ blocks: [{ ...reasoning, complete: true }, { ...answer, complete: true }] })));
    expect(container.querySelector(".process-disclosure")?.hasAttribute("open")).toBe(policy === "never-auto-collapse");
  });

  it("keeps tool errors visible while collapsed and stopped processing distinct from completion", () => {
    saveDisplayPreferences({ reasoningCollapsePolicy: "always-collapsed" });
    const tool = { id: "tool", stepIndex: 0, index: 0, name: "workspace_shell", arguments: "{}", approvalState: "failed" as const, requiresApproval: false, output: null, error: "Command failed", startedAt: 1, completedAt: 2, artifacts: [] };
    render(reply(makeGeneration({ status: "stopped", blocks: [reasoning], toolCalls: [tool] })));
    expect(screen.getByText("处理已停止")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Command failed");
  });
});

describe("inline image jobs", () => {
  function imageReply(job: ImageGenerationJobDto) {
    const message = imageRetryMessages()[1]!;
    message.generations[0]!.toolCalls = [{ ...message.generations[0]!.toolCalls[0]!, id: job.toolCallId! }];
    return <MessageItem conversationId="conv-1" message={message} callbacks={callbacks} imageJobs={new Map([[job.toolCallId!, [job]]])} />;
  }

  it.each([
    ["queued", "图片任务排队中", "停止图片生成"],
    ["running", "正在生成图片", "停止图片生成"],
    ["waiting-provider", "等待图片服务完成", "停止图片生成"],
    ["failed", "图片生成失败：Upstream request failed", "重试图片生成"],
    ["cancelled", "图片生成已取消", "重试图片生成"],
    ["completed", "图片已生成", null]
  ] as const)("shows %s independently of completed tool status and dispatches its control", async (status, label, control) => {
    appStore.set({ settings: makeSettings() });
    const job = makeImageJob({ status });
    const cancel = vi.spyOn(endpoints, "cancelImageGeneration").mockResolvedValue(job);
    const retry = vi.spyOn(endpoints, "retryImageGeneration").mockResolvedValue(job);
    vi.spyOn(endpoints, "messages").mockResolvedValue([]);
    render(imageReply(job));
    expect(screen.getByText(label)).toBeVisible();
    if (control) {
      fireEvent.click(screen.getByRole("button", { name: control }));
      await waitFor(() => expect(control === "停止图片生成" ? cancel : retry).toHaveBeenCalledWith("conv-1", job.id));
      await waitFor(() => expect(endpoints.messages).toHaveBeenCalledWith("conv-1"));
    }
  });

  it("keeps images outside disclosures, deduplicates tool previews, and preserves manual choices as jobs arrive", () => {
    appStore.set({ settings: makeSettings() });
    const messages = imageRetryMessages();
    const message = messages[1]!;
    const renderReply = (withJobs: boolean) => <MessageItem conversationId="conv-1" message={message} callbacks={callbacks}
      imageJobs={withJobs ? projectImageJobs(messages).imageJobs : undefined} />;
    const { container, rerender } = render(renderReply(false));
    const disclosure = container.querySelectorAll(".process-disclosure")[2]!;
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    rerender(renderReply(true));
    expect(container.querySelectorAll(".process-disclosure")[2]).toBe(disclosure);
    expect(disclosure).toHaveAttribute("open");
    fireEvent.click(disclosure.querySelector(".tool-call > summary")!);
    expect(screen.getAllByRole("img", { name: "beach.png" })).toHaveLength(1);
    const image = screen.getByRole("img", { name: "beach.png" });
    expect(image.closest("details")).toBeNull();
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(image).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("renders a saved task offline while disabling task mutations", () => {
    offlineStore.set({ offline: true });
    render(imageReply(structuredClone(makeImageJob())));
    expect(screen.getByRole("alert")).toHaveTextContent("Upstream request failed");
    expect(screen.getByRole("button", { name: "重试图片生成" })).toBeDisabled();
  });
});

it("disables a user retry without an answer and sends the resolved answer id when available", () => {
  const message = makeMessage({ role: "user", text: "Retry this turn", generations: [] });
  const onRetry = vi.fn();
  const renderUser = (retryTargetId?: string, branching = false) => <MessageItem conversationId="conv-1" message={message} retryTargetId={retryTargetId} callbacks={{ ...callbacks, onRetry, branching }} />;
  const { rerender } = render(renderUser());
  expect(screen.getByRole("button", { name: "重试回答" })).toBeDisabled();
  rerender(renderUser("answer-1"));
  fireEvent.click(screen.getByRole("button", { name: "重试回答" }));
  expect(onRetry).toHaveBeenCalledWith("answer-1");
  rerender(renderUser("answer-1", true));
  expect(screen.getByRole("button", { name: "重试回答" })).toBeDisabled();
});

it.each([
  [{ cachedInputTokens: 40, inputTokens: 100 }, "缓存 40（40%）"],
  [{ cachedInputTokens: 0, inputTokens: 100 }, "缓存 0（0%）"],
  [{ cachedInputTokens: 40 }, "缓存 40"],
  [{ cachedInputTokens: 0, inputTokens: 0 }, "缓存 0"],
  [{ inputTokens: 100 }, null]
] as const)("renders reported cache usage %j and compact elapsed seconds", (usage, expected) => {
  render(reply(makeGeneration({ usage, createdAt: 1000, completedAt: 4400 })));
  const summary = screen.getByRole("button", { name: "查看生成用量" });
  if (expected) expect(summary).toHaveTextContent(expected);
  else expect(summary).not.toHaveTextContent("缓存");
  expect(summary).toHaveTextContent("3.4s");
  expect(summary).not.toHaveTextContent(/3\.4\s+s/);
});
