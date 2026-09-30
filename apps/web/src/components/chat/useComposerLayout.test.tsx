import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useComposerLayout } from "./useComposerLayout";

it("uses resize notifications without reading layout and adapts to narrow tools and desktop media", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
  const readWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
  let resize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  let layout!: ReturnType<typeof useComposerLayout>;
  function Harness() { layout = useComposerLayout(); return <div ref={layout.ref} />; }
  const view = render(<Harness />);
  expect(layout.compact).toBe(true);
  const notify = (width: number) => act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
  notify(240);
  expect(layout.foldAgent).toBe(true);
  notify(300);
  expect(layout.foldAgent).toBe(false);
  act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
  expect(layout.foldAgent).toBe(true);
  expect(layout.compact).toBe(false);
  notify(200);
  expect(layout.compact).toBe(true);
  expect(readWidth).not.toHaveBeenCalled();
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("measures on mount and window resize when ResizeObserver is unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  let width = 200;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  let layout!: ReturnType<typeof useComposerLayout>;
  function Harness() { layout = useComposerLayout(); return <div ref={layout.ref} />; }
  render(<Harness />);
  expect(layout.foldAgent).toBe(true);
  expect(layout.compact).toBe(true);
  act(() => { width = 500; window.dispatchEvent(new Event("resize")); });
  expect(layout.foldAgent).toBe(false);
  expect(layout.compact).toBe(false);
});
