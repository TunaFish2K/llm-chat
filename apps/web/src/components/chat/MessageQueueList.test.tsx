import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMessageDto, MessageQueueStateDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { MessageQueueList, useMessageQueue } from "./MessageQueueList";

vi.mock("../../lib/app-state", () => ({ refreshMessages: vi.fn(), toastError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function Harness() {
  const queue = useMessageQueue("conversation");
  return <MessageQueueList conversationId="conversation" items={queue.items} reload={queue.reload} apply={queue.apply} paused={queue.paused} />;
}

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
  const first = screen.getByRole("button", { name: "在下一次工具返回时发送第一条" });
  expect(first.closest("li")).toHaveTextContent("first");
  expect(screen.getByRole("button", { name: "合并全部消息，在下一次工具返回时发送" }).closest("header")).not.toBeNull();
  fireEvent.click(first);
  await waitFor(() => expect(steer).toHaveBeenLastCalledWith("conversation", "first"));
  await waitFor(() => expect(screen.getByRole("button", { name: "合并全部消息，在下一次工具返回时发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "合并全部消息，在下一次工具返回时发送" }));
  await waitFor(() => expect(steer).toHaveBeenLastCalledWith("conversation", "all"));
  expect(reload).toHaveBeenCalledTimes(2);
  rerender(<MessageQueueList conversationId="conversation" items={[{ ...items[0]!, mode: "steer" }]} reload={reload} />);
  expect(screen.queryByRole("button", { name: "在下一次工具返回时发送第一条" })).toBeNull();
});

it("applies steer response immediately and ignores stale queue reloads", async () => {
  const initial = [{ id: "a", conversationId: "conversation", text: "first", mode: "queue", status: "pending", attachments: [], error: null, createdAt: 1, generationId: null }] as QueuedMessageDto[];
  const steered = [{ ...initial[0]!, mode: "steer" as const }];
  let resolveStale!: (state: MessageQueueStateDto) => void;
  vi.spyOn(endpoints, "queueState")
    .mockResolvedValueOnce({ items: initial, paused: false })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
  const steer = vi.spyOn(endpoints, "steerQueue").mockResolvedValue({ items: steered, paused: false });

  render(<Harness />);
  await waitFor(() => expect(screen.getByRole("button", { name: "在下一次工具返回时发送第一条" })).toBeEnabled());
  act(() => window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: { conversationId: "conversation" } })));
  await waitFor(() => expect(resolveStale).toBeTypeOf("function"));

  fireEvent.click(screen.getByRole("button", { name: "在下一次工具返回时发送第一条" }));
  await waitFor(() => expect(steer).toHaveBeenCalledWith("conversation", "first"));
  await waitFor(() => expect(screen.getByText("Steer · 下次请求")).toBeVisible());
  expect(screen.queryByRole("button", { name: "在下一次工具返回时发送第一条" })).toBeNull();

  await act(async () => resolveStale({ items: initial, paused: false }));
  expect(screen.getByText("Steer · 下次请求")).toBeVisible();
  expect(screen.queryByRole("button", { name: "在下一次工具返回时发送第一条" })).toBeNull();
});

it("keeps queue buttons disabled until reload settles for delete and resume", async () => {
  const items = [{ id: "a", text: "first", mode: "queue", status: "pending", attachments: [] }] as unknown as QueuedMessageDto[];
  let finishReload!: () => void;
  const reload = vi.fn(() => new Promise<void>((resolve) => { finishReload = resolve; }));
  vi.spyOn(endpoints, "deleteQueuedMessage").mockResolvedValue(undefined);
  vi.spyOn(endpoints, "resumeQueue").mockResolvedValue({ ok: true });

  render(<MessageQueueList conversationId="conversation" items={items} reload={reload} paused />);
  const resumeButton = screen.getByRole("button", { name: "继续发送" });
  fireEvent.click(resumeButton);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(resumeButton).toBeDisabled();
  await act(async () => finishReload());
  await waitFor(() => expect(resumeButton).toBeEnabled());

  const deleteButton = screen.getByRole("button", { name: /删除/ });
  fireEvent.click(deleteButton);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(deleteButton).toBeDisabled();
  await act(async () => finishReload());
  await waitFor(() => expect(deleteButton).toBeEnabled());
});
