import type { GenerationBlockDto, MessageDto, ToolCallDto } from "@llm-chat/contracts";
import { makeGeneration, makeMessage } from "../apps/web/test/fixtures";

// Anonymous shapes measured read-only on prv1. No production content or IDs.
export const heavyProfiles = [
  { name: "workspace", messageCount: 12, calls: [7, 18, 2, 2, 0, 0], reasoningChars: 60_857, outputChars: 39_228 },
  { name: "search", messageCount: 10, calls: [13, 2, 0, 4, 9], reasoningChars: 0, outputChars: 70_917 }
] as const;
export type HeavyProfile = typeof heavyProfiles[number];

const fill = (text: string, size: number) => text.repeat(Math.ceil(size / text.length)).slice(0, size);
export function heavyHistory(profile: HeavyProfile): MessageDto[] {
  const toolCount = profile.calls.reduce((sum, count) => sum + count, 0);
  let callIndex = 0;
  return Array.from({ length: profile.messageCount }, (_, index) => {
    const id = `${profile.name}-message-${index}`;
    if (index % 2 === 0) return makeMessage({ id, ordinal: index + 1, role: "user", text: `匿名请求 ${index / 2 + 1}`, createdAt: index + 1 });
    const turn = Math.floor(index / 2);
    const calls = profile.calls[turn]!;
    const toolCalls: ToolCallDto[] = Array.from({ length: calls }, (_, stepIndex) => {
      const size = Math.floor(profile.outputChars / toolCount) + (callIndex < profile.outputChars % toolCount ? 1 : 0);
      const name = profile.name === "workspace" ? "workspace_shell" : "search_web";
      const shell = { exitCode: 0, stdout: "", stderr: "" };
      const search = { results: Array.from({ length: 8 }, (_, result) => ({ title: `匿名结果 ${result}`, url: `https://example.com/${result}`, snippet: "" })) };
      if (profile.name === "workspace") shell.stdout = fill("anonymous log line ", size - JSON.stringify(shell).length);
      else {
        const remaining = size - JSON.stringify(search).length;
        search.results.forEach((result, index) => { result.snippet = fill("anonymous search text ", Math.floor(remaining / 8) + (index < remaining % 8 ? 1 : 0)); });
      }
      const output = JSON.stringify(profile.name === "workspace" ? shell : search);
      return { id: `${profile.name}-call-${callIndex++}`, index: stepIndex, stepIndex, name,
        arguments: JSON.stringify(profile.name === "workspace" ? { command: "cat anonymous.txt", cwd: "." } : { query: "anonymous query" }),
        approvalState: "completed", requiresApproval: false, output, error: null, startedAt: 2, completedAt: 3, artifacts: [],
        presentation: { builtin: { name, version: 1 }, arguments: { summary: "匿名调用", detail: "```text\nanonymous\n```" }, result: { summary: "完成", detail: fill("anonymous stored presentation\n", profile.name === "workspace" ? 1_794 : 2_695) } }
      };
    });
    const reasoningCount = profile.name === "workspace" ? [7, 18, 2, 2, 1, 1][turn]! : 0;
    const blocks: GenerationBlockDto[] = Array.from({ length: reasoningCount }, (_, stepIndex) => ({ id: `${id}-reasoning-${stepIndex}`, index: stepIndex, stepIndex, type: "reasoning" as const,
      content: fill("匿名推理内容。", turn === 4 ? 30_582 : turn === 5 ? 19_628 : Math.floor((profile.reasoningChars - 30_582 - 19_628) / 29) + (turn === 0 && stepIndex < 4 ? 1 : 0)), complete: true }));
    const textCount = profile.name === "workspace" ? [7, 18, 2, 1, 1, 1][turn]! : 1;
    for (let stepIndex = 0; stepIndex < textCount; stepIndex++) blocks.push({ id: `${id}-text-${stepIndex}`, index: reasoningCount + stepIndex, stepIndex: profile.name === "search" ? calls : stepIndex,
      type: "text", content: `${index === profile.messageCount - 1 ? "最新回复" : "匿名回复"}\n\n${fill("正文 **重点**。\n\n", profile.name === "search" ? 900 : 60)}`, complete: true });
    const generation = makeGeneration({ id: `${id}-generation`, blocks, toolCalls });
    return makeMessage({ id, ordinal: index + 1, activeGenerationId: generation.id, generations: [generation], createdAt: index + 1 });
  });
}
