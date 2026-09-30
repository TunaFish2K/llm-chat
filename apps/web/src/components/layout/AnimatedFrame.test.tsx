import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnimatedFrame } from "./AnimatedFrame";

afterEach(() => { vi.unstubAllGlobals(); document.querySelectorAll('[aria-hidden="true"].workspace-sidebar').forEach(element => element.remove()); });

it("freezes collapsing content, reverses cleanly, and never animates resize drags", async () => {
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }> = [];
  const animate = vi.fn(() => { const animation = { cancel: vi.fn(), finished: new Promise<void>(() => {}) }; animations.push(animation); return animation; });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const frame = this.closest(".app-frame") as HTMLElement;
    const width = frame?.dataset.sidebarCollapsed ? 64 : 276;
    return { left: this.matches(".workspace-main") ? width : 0, top: 0, width: this.matches(".workspace-main") ? 1440 - width : width, height: 900 } as DOMRect;
  });
  const content = <><aside className="workspace-sidebar"><button id="original-control">expanded content</button><iframe title="embedded content" /></aside><main className="workspace-main" /></>;
  const view = render(<AnimatedFrame left={276} right={0} sidebarCollapsed={false} inspectorOpen={false}>{content}</AnimatedFrame>);
  view.rerender(<AnimatedFrame left={64} right={0} sidebarCollapsed inspectorOpen={false}><aside className="workspace-sidebar">rail</aside><main className="workspace-main" /></AnimatedFrame>);
  const ghost = document.querySelector<HTMLElement>('.workspace-sidebar[aria-hidden="true"]')!;
  expect(ghost.textContent).toBe("expanded content"); expect(ghost.inert).toBe(true);
  expect(ghost.querySelector("iframe")).toBeNull();
  expect(document.querySelectorAll("#original-control")).toHaveLength(0);
  expect(animate).toHaveBeenCalledTimes(2);
  view.rerender(<AnimatedFrame left={276} right={0} sidebarCollapsed={false} inspectorOpen={false}>{content}</AnimatedFrame>);
  expect(ghost.isConnected).toBe(false); expect(animations[0]?.cancel).toHaveBeenCalled();
  animate.mockClear();
  view.rerender(<AnimatedFrame left={300} right={0} sidebarCollapsed={false} inspectorOpen={false}>{content}</AnimatedFrame>);
  expect(animate).not.toHaveBeenCalled(); view.unmount();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  await act(async () => {});
});

it("changes layout directly with reduced motion or without the animation API", () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  const content = <aside className="workspace-sidebar">content</aside>;
  const view = render(<AnimatedFrame left={276} right={0} sidebarCollapsed={false} inspectorOpen={false}>{content}</AnimatedFrame>);
  view.rerender(<AnimatedFrame left={64} right={0} sidebarCollapsed inspectorOpen={false}>{content}</AnimatedFrame>);
  expect(document.querySelector('.workspace-sidebar[aria-hidden="true"]')).toBeNull();
});
