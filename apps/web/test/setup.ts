import { setLocalePreference } from "../src/lib/i18n";
import { typographyStore, CHAT_TYPOGRAPHY_DEFAULTS } from "../src/lib/local-typography";
import { setConversationSource } from "../src/lib/conversation-lifecycle";
import { offlineStore } from "../src/lib/offline-history";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

const storageValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, String(value)); }
};
Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage });
const tabValues = new Map<string, string>();
const tabStorage: Storage = {
  get length() { return tabValues.size; },
  clear: () => tabValues.clear(),
  getItem: (key) => tabValues.get(key) ?? null,
  key: (index) => [...tabValues.keys()][index] ?? null,
  removeItem: (key) => { tabValues.delete(key); },
  setItem: (key, value) => { tabValues.set(key, String(value)); }
};
Object.defineProperty(window, "sessionStorage", { configurable: true, value: tabStorage });

Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class {
  observe() {} unobserve() {} disconnect() {}
} });

// jsdom does not implement EventSource or matchMedia; provide stable stubs.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  close(): void {
    this.closed = true;
  }
}

Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, writable: true, configurable: true });

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => { setLocalePreference("zh-CN"); });

afterEach(() => {
  offlineStore.set({ offline: false });
  cleanup();
  typographyStore.set({ values: { ...CHAT_TYPOGRAPHY_DEFAULTS }, initialized: false, saved: true });
  setConversationSource(crypto.randomUUID());
  memoryStorage.clear();
  tabStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeEventSource.instances.length = 0;
});

export { FakeEventSource };
