import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Toast } from "../../lib/toast-state";
import { ToastStack } from "./ToastStack";

const item = (id: number, text = `错误 ${id}`): Toast => ({ id, text, kind: "error", count: 1, remainingMs: 5_000 });
function setup(toasts: Toast[], suspended = false) {
  const dismiss = vi.fn(); const present = vi.fn(); const apply = vi.fn();
  const view = render(<ToastStack toasts={toasts} onDismiss={dismiss} onPresentationChange={present} suspended={suspended} updateAvailable={false} onApplyUpdate={apply} />);
  return { ...view, dismiss, present, apply };
}

it("shows the newest notification and exposes the other groups on request", () => {
  const { present } = setup([item(1), item(2), item(3)]);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent("错误 3");
  expect(present).toHaveBeenLastCalledWith([3], false);
  fireEvent.click(screen.getByRole("button", { name: "另有 2 条" }));
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  expect(present).toHaveBeenLastCalledWith([3, 2, 1], true);
  fireEvent.click(screen.getByRole("button", { name: "收起提示列表" }));
  expect(present).toHaveBeenLastCalledWith([3], false);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("dismisses only the requested notification and labels repeated failures", () => {
  const { dismiss } = setup([{ ...item(1), count: 3 }]);
  expect(screen.getByLabelText("重复 3 次")).toHaveTextContent("×3");
  fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(dismiss).toHaveBeenCalledWith(1);
});

it("pauses while hovered, keyboard-focused, or selecting message text", () => {
  const { container, present } = setup([item(1)]);
  const root = container.querySelector(".toast-stack")!;
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  expect(present).toHaveBeenLastCalledWith([1], true);
  fireEvent.pointerLeave(root);
  expect(present).toHaveBeenLastCalledWith([1], false);
  const close = screen.getByRole("button", { name: "关闭提示" });
  act(() => close.focus());
  expect(present).toHaveBeenLastCalledWith([1], true);
  act(() => close.blur());
  expect(present).toHaveBeenLastCalledWith([1], false);
  const range = document.createRange(); range.selectNodeContents(container.querySelector(".toast-message")!);
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(present).toHaveBeenLastCalledWith([1], true);
  window.getSelection()!.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
  expect(present).toHaveBeenLastCalledWith([1], false);
});

it("expands the full message and pauses expiration until details close", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(30);
  const { present } = setup([item(1, "完整错误详情".repeat(30))]);
  const expand = screen.getByRole("button", { name: "展开详情" });
  fireEvent.click(expand);
  expect(expand).toHaveAttribute("aria-expanded", "true");
  expect(present).toHaveBeenLastCalledWith([1], true);
  fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
  expect(present).toHaveBeenLastCalledWith([1], false);
});

it("hides notifications and preserves their remaining time in reading mode", () => {
  const { container, present } = setup([item(1)], true);
  expect(container.querySelector(".toast-stack")).toHaveAttribute("hidden");
  expect(present).toHaveBeenLastCalledWith([1], true);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the application update action available without dumping a long update error", () => {
  const apply = vi.fn();
  render(<ToastStack toasts={[item(1)]} onDismiss={vi.fn()} onPresentationChange={vi.fn()} updateAvailable onApplyUpdate={apply} updateError={"很长的更新错误".repeat(100)} />);
  const update = screen.getByText("更新失败，可在通用设置中查看详情").closest(".toast")! as HTMLElement;
  fireEvent.click(within(update).getByRole("button", { name: "更新并刷新" }));
  expect(apply).toHaveBeenCalledOnce();
});
