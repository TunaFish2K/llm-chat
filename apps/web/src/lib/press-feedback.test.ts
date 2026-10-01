import { expect, it, vi } from "vitest";
import { installPressFeedback } from "./press-feedback";
import { saveAnimationPreferences } from "./animation-preferences";

function pointer(type: string, target: HTMLElement, fields = {}) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: 10, clientY: 10, ...fields });
  target.dispatchEvent(event);
}

it("paints immediately, releases in 120ms, and cancels on scrolling", () => {
  vi.useFakeTimers();
  const button = document.createElement("button"); document.body.append(button);
  const dispose = installPressFeedback();
  pointer("pointerdown", button); expect(button.dataset.pressed).toBe("true");
  pointer("pointerup", button); expect(button.dataset.pressed).toBe("releasing");
  vi.advanceTimersByTime(120); expect(button.dataset.pressed).toBeUndefined();
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
    vi.advanceTimersByTime(39);
    expect(button.dataset.pressed).toBe("releasing");
    vi.advanceTimersByTime(1);
  }
  expect(button.dataset.pressed).toBeUndefined();
  dispose(); button.remove(); vi.useRealTimers();
});
