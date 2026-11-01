import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { useReadingMode } from "./reading-mode";
import { useBackLayer, useEscapeKey } from "./mobile-navigation";
import { useState } from "react";

function Reader({ scope = "one" }: { scope?: string }) {
  const { reading, enter, exit } = useReadingMode(scope);
  const [overlay, setOverlay] = useState(false);
  useBackLayer(overlay, () => setOverlay(false), 20);
  useEscapeKey();
  return <>
    <button onClick={enter}>Enter</button>
    <div data-testid="mode">{reading ? "reading" : "normal"}</div>
    <div className="chat-scroll" tabIndex={-1}><p>Body</p><a href="#">Link</a><pre data-no-back-gesture>Code</pre></div>
    <button onClick={() => setOverlay(true)}>Preview</button>
    {overlay && <span>Overlay</span>}
    {reading && <button className="sr-only" onClick={exit}>Exit</button>}
    <input aria-label="Editable" />
  </>;
}

const enter = () => fireEvent.click(screen.getByText("Enter"));
const reading = () => expect(screen.getByTestId("mode")).toHaveTextContent("reading");
const normal = () => expect(screen.getByTestId("mode")).toHaveTextContent("normal");
const touch = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });
function swipe(element: Element, dx: number, dy: number) {
  fireEvent.touchStart(element, { touches: [touch(200, 100)] });
  fireEvent.touchMove(element, { touches: [touch(200 + dx, 100 + dy)] });
  fireEvent.touchEnd(element, { touches: [], changedTouches: [touch(200 + dx, 100 + dy)] });
}
function tap(element: Element) {
  fireEvent.touchStart(element, { touches: [touch(200, 100)] });
  fireEvent.touchEnd(element, { touches: [], changedTouches: [touch(200, 100)] });
}

it("uses Esc and Q without stealing keys from previews, composition or editable fields", () => {
  render(<Reader />); enter(); reading();
  fireEvent.keyDown(window, { key: "q", isComposing: true }); reading();
  fireEvent.keyDown(window, { key: "q", ctrlKey: true }); reading();
  fireEvent.keyDown(screen.getByLabelText("Editable"), { key: "q" }); reading();
  fireEvent.click(screen.getByText("Preview"));
  fireEvent.keyDown(window, { key: "q" }); reading();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByText("Overlay")).toBeNull(); reading();
  fireEvent.keyDown(window, { key: "Escape" }); normal();
  enter(); fireEvent.keyDown(window, { key: "q" }); normal();
});

it("accepts a left swipe but keeps vertical scrolling and interactive content untouched", () => {
  render(<Reader />); enter();
  swipe(screen.getByText("Body"), -20, 100); reading();
  swipe(screen.getByText("Link"), -100, 0); reading();
  swipe(screen.getByText("Code"), -100, 0); reading();
  swipe(screen.getByText("Body"), -100, 10); normal();
});

it("accepts two taps but cancels after scrolling", () => {
  render(<Reader />); enter();
  tap(screen.getByText("Body")); fireEvent.scroll(window); tap(screen.getByText("Body")); reading();
  tap(screen.getByText("Body")); normal();
});

it("preserves text selection", () => {
  render(<Reader />); enter();
  const range = document.createRange(); range.selectNodeContents(screen.getByText("Body"));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  expect(window.getSelection()?.toString()).toBe("Body");
  tap(screen.getByText("Body")); tap(screen.getByText("Body")); reading();
  window.getSelection()?.removeAllRanges();
});

it("does not reactivate when returning to a previous conversation", () => {
  const { rerender } = render(<Reader />); enter(); reading();
  rerender(<Reader scope="two" />); normal();
  rerender(<Reader scope="one" />); normal();
});
