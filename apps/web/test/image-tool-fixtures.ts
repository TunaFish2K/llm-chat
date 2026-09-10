import type { ImageGenerationJobDto, MessageDto, ToolCallDto } from "@llm-chat/contracts";
import { makeGeneration, makeMessage } from "./fixtures";

export function makeImageJob(patch: Partial<ImageGenerationJobDto> = {}): ImageGenerationJobDto {
  return {
    id: "image-job", conversationId: "conv-1", assistantMessageId: "image-message", toolCallId: "image-call",
    modelId: "image-model", modelKey: "image-model", connectionName: "Images", imageProtocol: "openai-images",
    operation: "generate", prompt: "a beach", status: "failed", progress: null, providerJobId: null,
    outputAssets: [], revisedPrompt: null, error: { code: "upstream_error", message: "Upstream request failed" },
    createdAt: 3, startedAt: 4, completedAt: 5, ...patch
  };
}

/** The persisted shape: one long answer followed by two failed jobs and an image message. */
export function imageRetryMessages(conversationId = "conv-1"): MessageDto[] {
  const jobs = [1, 2, 3].map((attempt) => makeImageJob({
    id: `job-${attempt}`, conversationId, assistantMessageId: `image-${attempt}`, toolCallId: `call-${attempt}`,
    ...(attempt === 3 ? {
      status: "completed", error: null, outputAssets: [{
        id: "beach", fileName: "beach.png", kind: "image", mimeType: "image/png", byteSize: 68,
        sha256: "a".repeat(64), url: "/api/files/beach", createdAt: 10
      }]
    } : { error: { code: "upstream_error", message: `Upstream request failed (${attempt})` } })
  }));
  const calls: ToolCallDto[] = jobs.map((job, index) => ({
    id: job.toolCallId!, stepIndex: index, index: 0, name: "image_generate", arguments: '{"prompt":"a beach"}',
    approvalState: "completed", requiresApproval: false, output: JSON.stringify({ jobId: job.id, status: job.status }),
    error: null, startedAt: 3, completedAt: 5, artifacts: job.outputAssets
  }));
  return [
    makeMessage({ id: "user", ordinal: 1, role: "user", text: "画一个海滩" }),
    makeMessage({ id: "reply", ordinal: 2, activeGenerationId: "gen-1", generations: [makeGeneration({
      toolCalls: calls,
      blocks: ["开始画图", "第一次重试", "第二次重试", "海滩已画好"].map((content, stepIndex) => ({
        id: `text-${stepIndex}`, stepIndex, index: 0, type: "text", content, complete: true
      }))
    })] }),
    ...jobs.map((job, index) => makeMessage({ id: job.assistantMessageId, ordinal: index + 3, imageGenerationJob: job, attachments: job.outputAssets }))
  ];
}
