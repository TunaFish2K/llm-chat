import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createToastController, type Toast } from "./toast-state";

let items: Toast[];
let controller: ReturnType<typeof createToastController>;
beforeEach(() => {
  vi.useFakeTimers(); items = [];
  controller = createToastController(() => items, next => { items = next; });
});
afterEach(() => { controller.present([], true); vi.useRealTimers(); });

it("does not expire hidden notifications and starts the next timer only when presented", () => {
  controller.push("error", "older"); controller.push("error", "latest");
  const [older, latest] = items;
  vi.advanceTimersByTime(10_000);
  expect(items).toHaveLength(2);
  controller.present([latest!.id]); vi.advanceTimersByTime(5_000);
  expect(items.map(item => item.text)).toEqual(["older"]);
  vi.advanceTimersByTime(10_000); expect(items).toHaveLength(1);
  controller.present([older!.id]); vi.advanceTimersByTime(5_000);
  expect(items).toHaveLength(0);
});

it("preserves remaining time across pauses, reading mode and folded presentation", () => {
  controller.push("error", "message"); const id = items[0]!.id;
  controller.present([id]); vi.advanceTimersByTime(2_000);
  controller.present([id], true);
  expect(items[0]!.remainingMs).toBe(3_000);
  vi.advanceTimersByTime(20_000); expect(items).toHaveLength(1);
  controller.present([id]); vi.advanceTimersByTime(1_000);
  controller.present([]);
  expect(items[0]!.remainingMs).toBe(2_000);
  vi.advanceTimersByTime(20_000);
  controller.present([id]); vi.advanceTimersByTime(1_999);
  expect(items).toHaveLength(1);
  vi.advanceTimersByTime(1); expect(items).toHaveLength(0);
});

it("merges repeats, moves the group to latest and cancels its previous deadline", () => {
  controller.push("error", "repeat"); const id = items[0]!.id;
  controller.present([id]); vi.advanceTimersByTime(2_000);
  controller.push("success", "other"); controller.push("error", "repeat");
  expect(items.map(item => [item.text, item.count])).toEqual([["other", 1], ["repeat", 2]]);
  expect(items[1]!.id).toBe(id);
  vi.advanceTimersByTime(3_000); expect(items).toHaveLength(2);
  vi.advanceTimersByTime(2_000); expect(items.map(item => item.text)).toEqual(["other"]);
});

it("keeps different kinds and localized arguments distinct and caps the queue at five groups", () => {
  controller.push("error", { message: "same", i18n: { key: "ToastStack.more", params: { count: 1 } } });
  controller.push("error", { message: "same", i18n: { key: "ToastStack.more", params: { count: 2 } } });
  controller.push("info", "same");
  expect(items).toHaveLength(3);
  controller.present(items.map(item => item.id));
  for (let i = 0; i < 6; i++) controller.push("error", String(i));
  expect(items.map(item => item.text)).toEqual(["1", "2", "3", "4", "5"]);
  vi.advanceTimersByTime(10_000); expect(items).toHaveLength(5);
});

it("dismisses a notification without allowing its stale timer to dismiss another", () => {
  controller.push("error", "first"); const id = items[0]!.id;
  controller.present([id]); vi.advanceTimersByTime(2_000); controller.dismiss(id);
  controller.push("error", "second"); controller.present([items[0]!.id]);
  vi.advanceTimersByTime(3_000); expect(items[0]!.text).toBe("second");
  vi.advanceTimersByTime(2_000); expect(items).toHaveLength(0);
});
