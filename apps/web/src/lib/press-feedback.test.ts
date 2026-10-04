import { expect, it, vi } from "vitest";
import { installPressFeedback } from "./press-feedback";
import { saveAnimationPreferences } from "./animation-preferences";

function pointer(type: string, target: HTMLElement, fields = {}) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: 10, clientY: 10, ...fields });
  target.dispatchEvent(event);
}

it("paints immediately, releases in 250ms, and cancels on scrolling", () => {
  vi.useFakeTimers();
  const button = document.createElement("button"); document.body.append(button);
  const dispose = installPressFeedback();
  pointer("pointerdown", button); expect(button.dataset.pressed).toBe("true");
  pointer("pointerup", button); expect(button.dataset.pressed).toBe("releasing");
  vi.advanceTimersByTime(250); expect(button.dataset.pressed).toBeUndefined();
  pointer("pointerdown", button); pointer("pointermove", button, { clientY: 30 });
  expect(button.dataset.pressed).toBeUndefined();
  pointer("pointerdown", button); pointer("pointercancel", button);
  expect(button.dataset.pressed).toBeUndefined();
  pointer("pointerdown", button); window.dispatchEvent(new Event("blur"));
  expect(button.dataset.pressed).toBeUndefined();
  dispose(); button.remove(); vi.useRealTimers();
});

it("preserves text selection and excludes disabled and inert controls", () => {
  const button = document.createElement("button"), text = document.createElement("p");
  document.body.append(button, text);
  const dispose = installPressFeedback();
  pointer("pointerdown", text); expect(text.dataset.pressed).toBeUndefined();
  button.disabled = true; pointer("pointerdown", button); expect(button.dataset.pressed).toBeUndefined();
  button.disabled = false; button.setAttribute("inert", ""); pointer("pointerdown", button); expect(button.dataset.pressed).toBeUndefined();
  button.removeAttribute("inert"); pointer("pointerdown", button, { button: 2 }); expect(button.dataset.pressed).toBeUndefined();
  pointer("pointerdown", button); pointer("pointerup", button); pointer("pointerdown", text);
  expect(button.dataset.pressed).toBeUndefined();
  dispose(); button.remove(); text.remove();
});

it.each([0, 3])("releases feedback at its configured speed without delaying the press: %s", speed => {
  vi.useFakeTimers();
  saveAnimationPreferences({ feedback: speed });
  const button = document.createElement("button"); document.body.append(button);
  const dispose = installPressFeedback();
  pointer("pointerdown", button);
  expect(button.dataset.pressed).toBe("true");
  pointer("pointerup", button);
  if (speed) {
    vi.advanceTimersByTime(82);
    expect(button.dataset.pressed).toBe("releasing");
    vi.advanceTimersByTime(1);
  }
  expect(button.dataset.pressed).toBeUndefined();
  dispose(); button.remove(); vi.useRealTimers();
});

it("spreads a ripple from the pointer inside an overlay matched to the control and fades it out", () => {
  vi.useFakeTimers();
  saveAnimationPreferences({ feedback: 1 });
  const button = document.createElement("button"); document.body.append(button);
  button.style.borderRadius = "12px";
  button.getBoundingClientRect = () => ({ left: 100, top: 50, right: 200, bottom: 90, width: 100, height: 40, x: 100, y: 50, toJSON: () => ({}) });
  const dispose = installPressFeedback();
  pointer("pointerdown", button, { clientX: 110, clientY: 60 });
  const layer = document.querySelector<HTMLElement>(".press-ripple-layer")!;
  expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(layer.style).toMatchObject({ left: "100px", top: "50px", width: "100px", height: "40px", borderRadius: "12px" });
  expect(button.contains(layer)).toBe(false);
  const wave = layer.querySelector<HTMLElement>(".press-ripple")!;
  const radius = Math.hypot(90, 30);
  const square = document.createElement("a"); square.href = "#"; document.body.append(square);
  expect(parseFloat(wave.style.left) + radius).toBeCloseTo(10);
  expect(parseFloat(wave.style.top) + radius).toBeCloseTo(10);
  expect(parseFloat(wave.style.width)).toBeCloseTo(radius * 2);
  pointer("pointerup", button);
  expect(wave).toHaveAttribute("data-releasing");
  vi.advanceTimersByTime(180 + 250);
  expect(document.querySelector(".press-ripple-layer")).toBeNull();
  pointer("pointerdown", button, { clientX: 110, clientY: 60 }); pointer("pointermove", button, { clientX: 110, clientY: 80 });
  expect(document.querySelector(".press-ripple")).toHaveAttribute("data-releasing");
  vi.advanceTimersByTime(250);
  expect(document.querySelector(".press-ripple-layer")).toBeNull();
  square.getBoundingClientRect = button.getBoundingClientRect;
  pointer("pointerdown", square);
  expect(document.querySelector<HTMLElement>(".press-ripple-layer")!.style.borderRadius).toBe("var(--radius-sm, 8px)");
  dispose();
  expect(document.querySelector(".press-ripple-layer")).toBeNull();
  button.remove(); square.remove(); vi.useRealTimers();
});

it("skips ripples when click feedback is turned off", () => {
  saveAnimationPreferences({ feedback: 0 });
  const button = document.createElement("button"); document.body.append(button);
  button.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) });
  const dispose = installPressFeedback();
  pointer("pointerdown", button);
  expect(button.dataset.pressed).toBe("true");
  expect(document.querySelector(".press-ripple-layer")).toBeNull();
  dispose(); button.remove(); saveAnimationPreferences({ feedback: 1 });
});
