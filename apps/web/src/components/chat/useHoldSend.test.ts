import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useHoldSend } from "./useHoldSend";
afterEach(() => vi.useRealTimers());
it("sends once on tap release or hold threshold, ignoring repeat starts", () => {
  vi.useFakeTimers(); const send = vi.fn(); const { result } = renderHook(() => useHoldSend(send));
  act(() => { result.current.start(); vi.advanceTimersByTime(100); result.current.finish(); });
  expect(send).toHaveBeenCalledExactlyOnceWith(false); send.mockClear();
  act(() => { result.current.start(); result.current.start(); vi.advanceTimersByTime(450); result.current.finish(); });
  expect(send).toHaveBeenCalledExactlyOnceWith(true);
});
it("cancels a pending hold on blur or navigation", () => {
  vi.useFakeTimers(); const send = vi.fn(); const { result, rerender } = renderHook(({ id }) => useHoldSend(send, id), { initialProps: { id: "old" } });
  act(() => result.current.start()); rerender({ id: "new" });
  act(() => vi.runAllTimers()); expect(send).not.toHaveBeenCalled();
  act(() => { result.current.start(); window.dispatchEvent(new Event("blur")); vi.runAllTimers(); });
  expect(send).not.toHaveBeenCalled();
});
it("blocks the synthetic click after a hold even if layout moves another button under the pointer", () => {
  vi.useFakeTimers(); const send = vi.fn(); const unintended = vi.fn();
  const target = document.createElement("button"); document.body.append(target); target.addEventListener("click", unintended);
  const { result } = renderHook(() => useHoldSend(send));
  act(() => { result.current.start(true); vi.advanceTimersByTime(450); document.dispatchEvent(new Event("pointerup")); target.click(); });
  expect(send).toHaveBeenCalledExactlyOnceWith(true); expect(unintended).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown")); target.click(); expect(unintended).toHaveBeenCalledOnce(); target.remove();
});
