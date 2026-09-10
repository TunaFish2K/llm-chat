import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ActionButton } from "./action-feedback";

it.each([200, 800, 2000])("acknowledges a %i ms operation immediately and blocks double clicks", async (delay) => {
  vi.useFakeTimers();
  const click = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  render(<ActionButton onClick={click}>保存</ActionButton>);
  const button = screen.getByRole("button", { name: "保存" });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled(); expect(button).toHaveAttribute("data-action-pending", "true");
  expect(click).toHaveBeenCalledTimes(1);
  expect(button).not.toHaveAttribute("data-action-slow");
  await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
  expect(button).toBeEnabled(); expect(button).not.toHaveAttribute("data-action-pending");
  vi.useRealTimers();
});

it("does not report success on rejection and permits a deliberate retry", async () => {
  const errors: unknown[] = [];
  const listener = (event: Event) => errors.push((event as CustomEvent).detail);
  window.addEventListener("llm-chat:action-error", listener);
  const error = new Error("save failed");
  const click = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  render(<ActionButton onClick={click}>保存</ActionButton>);
  const button = screen.getByRole("button", { name: "保存" });
  await act(async () => { fireEvent.click(button); });
  expect(errors).toEqual([error]); expect(button).toBeEnabled();
  await act(async () => { fireEvent.click(button); });
  expect(click).toHaveBeenCalledTimes(2);
  window.removeEventListener("llm-chat:action-error", listener);
});

it("blocks conflicting actions in one row while other rows remain available", async () => {
  const { ActionGroup } = await import("./action-feedback");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const conflicting = vi.fn(), independent = vi.fn();
  render(<><ActionGroup><ActionButton onClick={() => pending}>重新加载 A</ActionButton><ActionButton onClick={conflicting}>卸载 A</ActionButton></ActionGroup>
    <ActionGroup><ActionButton onClick={independent}>重新加载 B</ActionButton></ActionGroup></>);
  fireEvent.click(screen.getByRole("button", { name: "重新加载 A" }));
  expect(screen.getByRole("button", { name: "卸载 A" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新加载 B" }));
  expect(independent).toHaveBeenCalledTimes(1); expect(conflicting).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(screen.getByRole("button", { name: "卸载 A" })).toBeEnabled();
});
