import { expect, it, vi } from "vitest";
import { optimisticWrite, overlayResource } from "./optimistic-resource";

it("serializes writes while exposing the latest edits and rolls back only a failed edit", async () => {
  let displayed = { name: "original", enabled: false };
  let reject!: (error: Error) => void;
  const first = optimisticWrite("test-resource", displayed, (value) => ({ ...value, name: "first" }),
    (value) => { displayed = value; }, () => new Promise((_, fail) => { reject = fail; }));
  const second = optimisticWrite("test-resource", displayed, (value) => ({ ...value, enabled: true }),
    (value) => { displayed = value; }, async () => ({ name: "original", enabled: true }));
  expect(displayed).toEqual({ name: "first", enabled: true });
  expect(overlayResource("test-resource", { name: "stale", enabled: false })).toEqual({ name: "first", enabled: true });
  await Promise.resolve(); await Promise.resolve();
  reject(new Error("failed"));
  await first.catch(() => {}); await second;
  expect(displayed).toEqual({ name: "original", enabled: true });
});

it("discards queued commits and late results when the login or service changes", async () => {
  let resolve!: (value: string) => void;
  let displayed = "original";
  const first = optimisticWrite("cleared-resource", displayed, () => "first", (value) => { displayed = value; },
    () => new Promise<string>((done) => { resolve = done; }));
  const commit = vi.fn(async () => "second");
  const second = optimisticWrite("cleared-resource", displayed, () => "second", (value) => { displayed = value; }, commit);
  const outcome = second.catch((error: unknown) => error);
  await Promise.resolve(); await Promise.resolve();
  window.dispatchEvent(new Event("llm-chat:submissions-clear"));
  displayed = "new session";
  resolve("first"); await first;
  expect(await outcome).toBeInstanceOf(Error);
  expect(commit).not.toHaveBeenCalled();
  expect(displayed).toBe("new session");
});
