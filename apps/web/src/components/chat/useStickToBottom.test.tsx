import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStickToBottom, type StickToBottom } from "./useStickToBottom";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  let resize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  let scroll!: StickToBottom;
  function Harness({ version = 0 }: { version?: number }) {
    scroll = useStickToBottom([version], true);
    return <div ref={scroll.ref} onScroll={scroll.onScroll}><div ref={scroll.contentRef}>content</div></div>;
  }
  const view = render(<Harness />);
  const element = scroll.ref.current!;
  let top = 600;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, writable: true, value: 1000 },
    clientHeight: { configurable: true, writable: true, value: 400 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, element.scrollHeight - element.clientHeight)); } }
  });
  const scrollTo = vi.fn();
  element.scrollTo = scrollTo;
  act(() => { fireEvent.scroll(element); vi.advanceTimersByTime(20); });

  return {
    view, element, scrollTo, disconnect, update() { view.rerender(<Harness version={1} />); }, get scroll() { return scroll; },
    queueResize() { act(() => resize([], {} as ResizeObserver)); },
    resize() { act(() => { resize([], {} as ResizeObserver); vi.advanceTimersByTime(20); }); }
  };
}

it("follows a disclosure resize without a message update, but stops for an upward wheel gesture", () => {
  const state = setup();
  Object.defineProperty(state.element, "scrollHeight", { value: 1400 });
  state.resize();
  expect(state.element.scrollTop).toBe(1000);
  expect(state.scroll.detached).toBe(false);
  fireEvent.wheel(state.element, { deltaY: -100 });
  state.element.scrollTop = 900;
  fireEvent.scroll(state.element);
  Object.defineProperty(state.element, "scrollHeight", { value: 1800 });
  state.resize();
  expect(state.element.scrollTop).toBe(900);
  expect(state.scroll.detached).toBe(true);
});

it("does not detach when collapsing content clamps the scroll position", () => {
  const state = setup();
  Object.defineProperty(state.element, "scrollHeight", { value: 700 });
  state.element.scrollTop = 300;
  fireEvent.scroll(state.element);
  expect(state.scroll.detached).toBe(false);
  state.resize();
  expect(state.element.scrollTop).toBe(300);
});

it("keeps following when duplicate scroll events arrive before a content resize is followed", () => {
  const state = setup();
  Object.defineProperty(state.element, "scrollHeight", { value: 1400 });
  fireEvent.scroll(state.element);
  fireEvent.scroll(state.element);
  expect(state.scroll.detached).toBe(false);
  act(() => vi.advanceTimersByTime(20));
  expect(state.element.scrollTop).toBe(1000);
});

it("keeps following during a smooth jump and lets the reader interrupt it", () => {
  const state = setup();
  state.element.scrollTop = 200;
  fireEvent.scroll(state.element);
  act(() => state.scroll.toBottom("smooth"));
  state.element.scrollTop = 350;
  fireEvent.scroll(state.element);
  expect(state.scroll.detached).toBe(false);
  fireEvent.wheel(state.element, { deltaY: -40 });
  expect(state.scroll.detached).toBe(true);
  expect(state.scrollTo).toHaveBeenLastCalledWith({ top: 350, behavior: "auto" });
});

it("disconnects the observer and cancels queued follow work on unmount", () => {
  const state = setup();
  state.queueResize();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  state.view.unmount();
  expect(state.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("finishes an immediate jump despite a trailing inertia event, but allows a new upward gesture", () => {
  const state = setup();
  state.element.scrollTop = 200;
  fireEvent.scroll(state.element);
  act(() => { state.scroll.toBottom(); state.scroll.scheduleFollow(); });
  expect(state.element.scrollTop).toBe(600);
  state.element.scrollTop = 500;
  fireEvent.scroll(state.element);
  expect(state.scroll.detached).toBe(false);
  act(() => vi.advanceTimersByTime(20));
  expect(state.element.scrollTop).toBe(600);
  // Compositor scrolling may deliver another event after the layout frame.
  state.element.scrollTop = 550;
  fireEvent.scroll(state.element);
  fireEvent(state.element, new Event("scrollend"));
  act(() => vi.advanceTimersByTime(20));
  state.element.scrollTop = 560;
  fireEvent.scroll(state.element);
  fireEvent(state.element, new Event("scrollend"));
  act(() => vi.advanceTimersByTime(40));
  expect(state.element.scrollTop).toBe(600);
  expect(state.scroll.detached).toBe(false);

  state.element.scrollTop = 200;
  fireEvent.scroll(state.element);
  act(() => { state.scroll.toBottom(); state.scroll.scheduleFollow(); });
  fireEvent.wheel(state.element, { deltaY: -100 });
  state.element.scrollTop = 500;
  fireEvent.scroll(state.element);
  act(() => vi.advanceTimersByTime(20));
  expect(state.scroll.detached).toBe(true);
  expect(state.element.scrollTop).toBe(500);
});

it("resumes if content grows between reaching the bottom and delivery of the scroll event", () => {
  const state = setup();
  state.element.scrollTop = 200;
  fireEvent.scroll(state.element);
  state.element.scrollTop = 600;
  Object.defineProperty(state.element, "scrollHeight", { value: 1400 });
  state.update();
  act(() => vi.advanceTimersByTime(20));
  expect(state.scroll.detached).toBe(false);
  expect(state.element.scrollTop).toBe(1000);
});

it("coalesces message and resize updates into one layout pass outside the render commit", () => {
  const state = setup();
  const measure = vi.fn(() => 1400);
  Object.defineProperty(state.element, "scrollHeight", { configurable: true, get: measure });
  Object.defineProperty(state.element, "scrollTop", { configurable: true, writable: true, value: 600 });
  state.update();
  state.queueResize();
  state.queueResize();
  expect(measure).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(20));
  expect(measure).toHaveBeenCalledOnce();
  expect(state.element.scrollTop).toBe(1000);
});
