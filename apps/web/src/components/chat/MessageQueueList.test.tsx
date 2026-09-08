import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMessageDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { useMessageQueue } from "./MessageQueueList";

vi.mock("../../lib/app-state", () => ({ loadMessages: vi.fn(async () => {}), toastError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each(["focus", "pageshow", "llm-chat:queue-reconnect"])("clears sent items after a missed event on %s", async (event) => {
  const queued = [{ id: "pending", text: "next" }] as QueuedMessageDto[];
  const get = vi.spyOn(endpoints, "queuedMessages").mockResolvedValueOnce(queued).mockResolvedValue([]);
  const { result } = renderHook(() => useMessageQueue("conversation"));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => window.dispatchEvent(new Event(event)));
  await waitFor(() => expect(result.current.items).toEqual([]));
  expect(get).toHaveBeenCalledTimes(2);
});

it("discards a stale response after switching conversations", async () => {
  let resolve!: (items: QueuedMessageDto[]) => void;
  vi.spyOn(endpoints, "queuedMessages").mockImplementation((id) => id === "old" ? new Promise((done) => { resolve = done; }) : Promise.resolve([]));
  const { result, rerender } = renderHook(({ id }) => useMessageQueue(id), { initialProps: { id: "old" } });
  rerender({ id: "new" });
  await act(async () => resolve([{ id: "old-item" }] as QueuedMessageDto[]));
  expect(result.current.items).toEqual([]);
});
