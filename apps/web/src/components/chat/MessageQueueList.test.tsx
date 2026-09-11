import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMessageDto, MessageQueueStateDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { useMessageQueue } from "./MessageQueueList";

vi.mock("../../lib/app-state", () => ({ refreshMessages: vi.fn(), toastError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each(["focus", "pageshow", "llm-chat:queue-reconnect"])("clears sent items after a missed event on %s", async (event) => {
  const queued = [{ id: "pending", text: "next" }] as QueuedMessageDto[];
  const get = vi.spyOn(endpoints, "queueState").mockResolvedValueOnce({ items: queued, paused: true }).mockResolvedValue({ items: [], paused: false });
  const { result } = renderHook(() => useMessageQueue("conversation"));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  expect(result.current.paused).toBe(true);
  act(() => window.dispatchEvent(new Event(event)));
  await waitFor(() => expect(result.current.items).toEqual([]));
  expect(get).toHaveBeenCalledTimes(2);
  expect(result.current.paused).toBe(false);
});

it("discards a stale response after switching conversations", async () => {
  let resolve!: (state: MessageQueueStateDto) => void;
  vi.spyOn(endpoints, "queueState").mockImplementation((id) => id === "old" ? new Promise((done) => { resolve = done; }) : Promise.resolve({ items: [], paused: false }));
  const { result, rerender } = renderHook(({ id }) => useMessageQueue(id), { initialProps: { id: "old" } });
  rerender({ id: "new" });
  await act(async () => resolve({ items: [{ id: "old-item" }] as QueuedMessageDto[], paused: true }));
  expect(result.current.items).toEqual([]);
  expect(result.current.paused).toBe(false);
});
