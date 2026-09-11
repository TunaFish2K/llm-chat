import type { GenerationDto } from "@llm-chat/contracts";

type Block = GenerationDto["blocks"][number];
const UPDATE_INTERVAL_MS = 50;

/** Blocks contain cumulative text. Keep only the latest value of each block between paints. */
export class GenerationBlockBuffer {
  private pending = new Map<string, { blocks: Map<string, Block>; timer: ReturnType<typeof setTimeout> }>();

  constructor(private publish: (generationId: string, blocks: Block[]) => void) {}

  push(generationId: string, block: Block): void {
    const current = this.pending.get(generationId);
    if (current) {
      current.blocks.set(`${block.stepIndex}:${block.index}`, block);
      return;
    }
    this.arm(generationId);
    this.publish(generationId, [block]);
  }

  private arm(generationId: string): void {
    const blocks = new Map<string, Block>();
    const timer = setTimeout(() => {
      this.pending.delete(generationId);
      if (!blocks.size) return;
      this.arm(generationId);
      this.publish(generationId, [...blocks.values()]);
    }, UPDATE_INTERVAL_MS);
    this.pending.set(generationId, { blocks, timer });
  }

  take(generationId: string): Block[] {
    const current = this.pending.get(generationId);
    if (!current) return [];
    clearTimeout(current.timer);
    this.pending.delete(generationId);
    return [...current.blocks.values()];
  }

  clear(): void {
    for (const id of this.pending.keys()) this.take(id);
  }
}
