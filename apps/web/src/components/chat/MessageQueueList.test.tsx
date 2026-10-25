import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMessageDto, MessageQueueStateDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { MessageQueueList, useMessageQueue } from "./MessageQueueList";

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

it("sends the first or all queued messages at the next tool return", async () => {
  const steer = vi.spyOn(endpoints, "steerQueue").mockResolvedValue({ items: [], paused: false });
  const reload = vi.fn().mockResolvedValue(undefined);
  const items = [{ id: "a", text: "first", mode: "queue", status: "pending", attachments: [] }, { id: "b", text: "second", mode: "queue", status: "pending", attachments: [] }] as unknown as QueuedMessageDto[];
  const { rerender } = render(<MessageQueueList conversationId="conversation" items={items} reload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "在下一次工具返回时发送第一条" }));
  await waitFor(() => expect(steer).toHaveBeenLastCalledWith("conversation", "first"));
  await waitFor(() => expect(screen.getByRole("button", { name: "合并全部消息，在下一次工具返回时发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "合并全部消息，在下一次工具返回时发送" }));
  await waitFor(() => expect(steer).toHaveBeenLastCalledWith("conversation", "all"));
  expect(reload).toHaveBeenCalledTimes(2);
  rerender(<MessageQueueList conversationId="conversation" items={[{ ...items[0]!, mode: "steer" }]} reload={reload} />);
  expect(screen.queryByRole("button", { name: "在下一次工具返回时发送第一条" })).toBeNull();
});
