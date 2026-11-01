import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConversationSearch } from "./ConversationSearch";
import { endpoints } from "../lib/api";

it("keeps old search results visible but cannot select them after a new query fails", async () => {
  const search = vi.spyOn(endpoints, "searchConversations").mockResolvedValueOnce([
    { conversationId: "old", title: "原结果", snippet: "previous query", updatedAt: 1 }
  ]).mockRejectedValueOnce(new Error("搜索暂时不可用"));
  const select = vi.spyOn(endpoints, "selectConversationBranch");
  const close = vi.fn();
  render(<ConversationSearch onClose={close} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "previous" } });
  const old = await screen.findByRole("option", { name: /原结果/ });
  const previousSignal = search.mock.calls[0]![1]!;
  fireEvent.change(input, { target: { value: "new" } });
  expect(previousSignal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("搜索暂时不可用"));
  expect(old).toBeVisible();
  expect(old.parentElement).toHaveAttribute("inert");
  fireEvent.click(old); fireEvent.keyDown(input, { key: "Enter" });
  expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});

it("closes on Escape even while a query is present", async () => {
  vi.spyOn(endpoints, "searchConversations").mockResolvedValue([]);
  const close = vi.fn();
  render(<ConversationSearch onClose={close} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "draft" } });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
