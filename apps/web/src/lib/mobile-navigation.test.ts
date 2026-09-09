import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dismissBackLayer, parentRoute, requestMobileBack, useBackLayer, useMobileBackGesture } from "./mobile-navigation";

function touch(type: string, points: Array<[number, number, number?]>, target: EventTarget = document.body, cancelable = true) {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY, identifier = 1]) => ({ clientX, clientY, identifier })) });
  act(() => { target.dispatchEvent(event); });
  return event;
}

it("resolves semantic parents independently of browser history", () => {
  expect(parentRoute({ name: "agents", agentId: "a" })).toBe("/agents");
  expect(parentRoute({ name: "agents", agentId: null })).toBeNull();
  expect(parentRoute({ name: "settings", section: "connections" })).toBeNull();
  expect(parentRoute({ name: "tasks", taskId: "legacy" })).toBeNull();
  expect(parentRoute({ name: "chat", conversationId: null, view: "chat", taskId: null })).toBeNull();
  expect(parentRoute({ name: "chat", conversationId: "c", view: "tasks", taskId: "t" })).toBe("/c/c/tasks");
  expect(parentRoute({ name: "chat", conversationId: "c", view: "tasks", taskId: null })).toBe("/c/c");
  expect(parentRoute({ name: "chat", conversationId: "c", view: "trajectory", taskId: null })).toBe("/c/c");
  expect(parentRoute({ name: "chat", conversationId: "c", view: "chat", taskId: null })).toBeNull();
});

it("dismisses the foreground layer and retains the latest close callback", () => {
  expect(dismissBackLayer()).toBe(false);
  const drawer = vi.fn(); const modal = vi.fn(); const latest = vi.fn();
  const first = renderHook(() => useBackLayer(true, drawer, 10));
  const second = renderHook(({ close }) => useBackLayer(true, close, 30), { initialProps: { close: modal } });
  second.rerender({ close: latest });
  act(() => { expect(dismissBackLayer()).toBe(true); });
  expect(latest).toHaveBeenCalledTimes(1); expect(drawer).not.toHaveBeenCalled();
  second.unmount();
  act(() => { dismissBackLayer(); }); expect(drawer).toHaveBeenCalledTimes(1);
  first.unmount(); expect(dismissBackLayer()).toBe(false);
  const listener = vi.fn(); window.addEventListener("llm-chat:back", listener);
  requestMobileBack(); expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener("llm-chat:back", listener);
});

describe("mobile edge gesture", () => {
  it("commits once, suppresses the synthetic click and uses updated callbacks", () => {
    const back = vi.fn(); const latest = vi.fn();
    const hook = renderHook(({ callback }) => useMobileBackGesture(true, callback), { initialProps: { callback: back } });
    touch("touchstart", [[10, 100]]);
    expect(touch("touchmove", [[120, 103]]).defaultPrevented).toBe(true);
    expect(hook.result.current).toBe(96);
    hook.rerender({ callback: latest });
    touch("touchend", []);
    expect(latest).toHaveBeenCalledTimes(1); expect(back).not.toHaveBeenCalled();
    expect(hook.result.current).toBe(0);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
    const next = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(next); expect(next.defaultPrevented).toBe(false);
  });

  it("leaves vertical pull-to-refresh native and cancels short, reversed and interrupted gestures", () => {
    const back = vi.fn(); renderHook(() => useMobileBackGesture(true, back));
    touch("touchmove", [[100, 100]]);
    touch("touchstart", [[10, 100]]);
    expect(touch("touchmove", [[12, 180]]).defaultPrevented).toBe(false);
    touch("touchend", []);
    for (const [x, y] of [[14, 100], [-20, 100], [40, 100], [22, 110]]) {
      touch("touchstart", [[10, 100]]); touch("touchmove", [[x!, y!]]); touch("touchend", []);
    }
    touch("touchstart", [[10, 100]]); touch("touchmove", [[90, 100]]); touch("touchcancel", []); touch("touchend", []);
    touch("touchstart", [[10, 100]]); touch("touchmove", [[90, 100]], document.body, false); touch("touchend", []);
    touch("touchstart", [[10, 100]]); touch("touchmove", [[90, 100, 2]]); touch("touchend", []);
    touch("touchstart", [[10, 100]]); touch("touchmove", []); touch("touchend", []);
    touch("touchstart", [[10, 100]]); touch("touchmove", [[90, 100], [20, 100]]); touch("touchend", []);
    expect(back).not.toHaveBeenCalled();
  });

  it("ignores non-edge, multi-touch, editing, selection and horizontal scroll targets", () => {
    const back = vi.fn(); renderHook(() => useMobileBackGesture(true, back));
    touch("touchstart", []); touch("touchstart", [[10, 100], [20, 100]]); touch("touchmove", [[100, 100]]); touch("touchend", []);
    touch("touchstart", [[30, 100]]); touch("touchmove", [[120, 100]]); touch("touchend", []);
    touch("touchstart", [[10, 100]], window); touch("touchmove", [[120, 100]]); touch("touchend", []);
    const input = document.createElement("textarea"); document.body.append(input);
    touch("touchstart", [[10, 100]], input); touch("touchmove", [[120, 100]], input); touch("touchend", [], input); input.remove();
    const scroller = document.createElement("div"); scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, { scrollWidth: { value: 500 }, clientWidth: { value: 100 } }); document.body.append(scroller);
    touch("touchstart", [[10, 100]], scroller); touch("touchmove", [[120, 100]], scroller); touch("touchend", [], scroller); scroller.remove();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as Selection);
    touch("touchstart", [[10, 100]]); touch("touchmove", [[120, 100]]); touch("touchend", []);
    expect(back).not.toHaveBeenCalled();
  });

  it("does not register gestures on desktop and cleans up on unmount", () => {
    const back = vi.fn(); const hook = renderHook(({ enabled }) => useMobileBackGesture(enabled, back), { initialProps: { enabled: false } });
    touch("touchstart", [[10, 100]]); touch("touchmove", [[120, 100]]); touch("touchend", []);
    expect(back).not.toHaveBeenCalled(); expect(hook.result.current).toBe(0);
    hook.rerender({ enabled: true }); hook.unmount();
    touch("touchstart", [[10, 100]]); touch("touchmove", [[120, 100]]); touch("touchend", []);
    expect(back).not.toHaveBeenCalled();
    const layer = renderHook(() => useBackLayer(false, back)); layer.unmount();
  });
});
