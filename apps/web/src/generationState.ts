import type { GenerationDto, GenerationEvent, MessageDto } from "@llm-chat/contracts";

export function applyGenerationEvent(messages: MessageDto[], event: GenerationEvent): MessageDto[] {
  if (event.type === "snapshot") return updateGeneration(messages, event.generation.id, () => event.generation);
  if (event.type === "block-delta") return updateGeneration(messages, event.generationId, (generation) => ({
    ...generation,
    blocks: upsertBlock(generation.blocks, event.block)
  }));
  if (event.type === "usage") return updateGeneration(messages, event.generationId, (generation) => ({
    ...generation,
    usage: event.usage
  }));
  if (event.type === "tool-call") return updateGeneration(messages, event.generationId, (generation) => ({
    ...generation,
    toolCalls: [...generation.toolCalls.filter((item) => item.id !== event.toolCall.id), event.toolCall]
      .sort((a, b) => a.index - b.index)
  }));
  if (event.type === "status") return updateGeneration(messages, event.generationId, (generation) => ({
    ...generation,
    status: event.status,
    stopReason: event.stopReason ?? generation.stopReason
  }));
  return updateGeneration(messages, event.generationId, (generation) => ({
    ...generation,
    status: "failed",
    error: { code: event.code, message: event.message }
  }));
}

export function updateGeneration(
  messages: MessageDto[],
  id: string,
  update: (generation: GenerationDto) => GenerationDto
): MessageDto[] {
  return messages.map((message) => ({
    ...message,
    generations: message.generations.map((generation) => generation.id === id ? update(generation) : generation)
  }));
}

export function upsertBlock(
  blocks: GenerationDto["blocks"],
  block: GenerationDto["blocks"][number]
): GenerationDto["blocks"] {
  return [...blocks.filter((item) => item.index !== block.index), block].sort((a, b) => a.index - b.index);
}

export function blockText(
  generation: GenerationDto,
  types: GenerationDto["blocks"][number]["type"][]
): string {
  return generation.blocks
    .filter((block) => types.includes(block.type))
    .map((block) => block.content)
    .join(types.includes("reasoning") ? "\n" : "");
}

export function streamEnded(status: string): boolean {
  return ["waiting-approval", "completed", "stopped", "failed", "interrupted"].includes(status);
}
