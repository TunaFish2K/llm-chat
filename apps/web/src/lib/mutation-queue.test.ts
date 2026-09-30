import { expect, it, vi } from "vitest";
import { clearMutationQueues, serializeMutation } from "./mutation-queue";

it("orders writes per resource while independent resources proceed", async () => {
  let finish!: (value: number) => void;
  const first = serializeMutation("one", () => new Promise<number>(resolve => { finish = resolve; }));
  const secondWrite = vi.fn(async () => 2);
  const second = serializeMutation("one", secondWrite);
  await expect(serializeMutation("two", async () => 3)).resolves.toBe(3);
  expect(secondWrite).not.toHaveBeenCalled();
  finish(1);
  await expect(first).resolves.toBe(1);
  await expect(second).resolves.toBe(2);
});

it("continues after a rejection and fences commands queued before logout", async () => {
  await expect(serializeMutation("one", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  await expect(serializeMutation("one", async () => 4)).resolves.toBe(4);
  const write = vi.fn(async () => 5);
  const queued = serializeMutation("stale", write);
  clearMutationQueues();
  await expect(queued).rejects.toThrow("Session changed");
  expect(write).not.toHaveBeenCalled();
});
