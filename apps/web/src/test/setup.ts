import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";

configure({ asyncUtilTimeout: 3_000 });

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: TestResizeObserver });

const getComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(window, "getComputedStyle", {
  configurable: true,
  value: (element: Element) => getComputedStyle(element)
});

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(() => ({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() }))
  }))
});

class TestNotification {
  static readonly permission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  close() {}
}
Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: TestNotification });

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  expect(warn, "unexpected console.warn output").not.toHaveBeenCalled();
  expect(error, "unexpected console.error output").not.toHaveBeenCalled();
  warn.mockRestore();
  error.mockRestore();
});
