import { createStore, useStore } from "./store";
import { setStartupAuthRequired } from "./startup-cache";

/**
 * Server channels are other network entrances (hosts or ports) of the server
 * that published this page. The list lives only on this device, so it can be
 * edited while no channel is reachable. API traffic follows the active
 * channel; caches stay valid because every channel must report one identity.
 */
export const SERVER_CHANNELS_KEY = "llm-chat.server-channels.v1";
export const SERVER_ID_HEADER = "x-llm-chat-server-id";

export interface ServerChannelState { channels: string[]; active: string | null; boundServerId: string | null }
export type ChannelInputError = "invalid" | "scheme" | "site" | "current" | "duplicate";

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Mirrors the server: the registrable domain is approximated by dropping the first label. */
function siteOf(hostname: string): string | null {
  if (IPV4.test(hostname) || hostname.startsWith("[")) return null;
  const labels = hostname.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : hostname;
}

/** Channels must share the page's scheme and site so session cookies and CSP allow them. */
function compatible(channel: URL, page: URL): boolean {
  if (channel.protocol !== page.protocol) return false;
  const site = siteOf(page.hostname);
  return site ? siteOf(channel.hostname) === site : channel.hostname === page.hostname;
}

function pageUrl(): URL { return new URL(location.origin); }

export function parseChannel(input: string): { origin: string } | { error: ChannelInputError } {
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `${location.protocol}//${text}`); }
  catch { return { error: "invalid" }; }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return { error: "invalid" };
  const page = pageUrl();
  if (url.protocol !== page.protocol) return { error: "scheme" };
  if (!compatible(url, page)) return { error: "site" };
  if (url.origin === page.origin) return { error: "current" };
  return { origin: url.origin };
}

function normalize(value: unknown): ServerChannelState {
  const record = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof ServerChannelState, unknown>>;
  const channels = Array.isArray(record.channels)
    ? [...new Set(record.channels.flatMap((item) => {
      if (typeof item !== "string") return [];
      const parsed = parseChannel(item);
      return "origin" in parsed ? [parsed.origin] : [];
    }))]
    : [];
  const active = typeof record.active === "string" && channels.includes(record.active) ? record.active : null;
  const boundServerId = typeof record.boundServerId === "string" && record.boundServerId ? record.boundServerId : null;
  return { channels, active, boundServerId };
}

let volatile: ServerChannelState | undefined;
function readState(): ServerChannelState {
  if (volatile) return volatile;
  try { return normalize(JSON.parse(localStorage.getItem(SERVER_CHANNELS_KEY) ?? "null")); }
  catch { return normalize(null); }
}
// `mismatch` is page state: the active channel reported another server this load.
const store = createStore({ ...readState(), saved: true, mismatch: false });

function write(next: ServerChannelState): void {
  let saved = true;
  try {
    localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify(next));
    volatile = undefined;
  } catch { saved = false; volatile = next; }
  store.set({ ...next, saved });
}

function state(): ServerChannelState {
  const { channels, active, boundServerId } = store.get();
  return { channels, active, boundServerId };
}

export function useServerChannels() {
  return useStore(store, (value) => value);
}

/** The origin API requests go to; empty for the page origin. */
export function apiBase(): string {
  return state().active ?? "";
}

export function apiUrl(path: string): string {
  return apiBase() + path;
}

/** Server-relative API asset URLs follow the active channel; others are unchanged. */
export function assetUrl(url: string): string;
export function assetUrl(url: string | undefined): string | undefined;
export function assetUrl(url: string | undefined): string | undefined {
  return url?.startsWith("/api/") ? apiUrl(url) : url;
}

/** Credentials mode that sends the channel's own session cookie. */
export function apiCredentials(): RequestCredentials {
  return apiBase() ? "include" : "same-origin";
}

function switchTo(next: ServerChannelState, reload: boolean): void {
  write(next);
  if (!reload) return;
  // The next channel keeps its own session; let its first request decide.
  setStartupAuthRequired(false);
  location.reload();
}

export function addChannel(input: string): ChannelInputError | null {
  const parsed = parseChannel(input);
  if ("error" in parsed) return parsed.error;
  const current = state();
  if (current.channels.includes(parsed.origin)) return "duplicate";
  write({ ...current, channels: [...current.channels, parsed.origin] });
  return null;
}

export function removeChannel(origin: string): void {
  const current = state();
  if (!current.channels.includes(origin)) return;
  const wasActive = current.active === origin;
  switchTo({ ...current, channels: current.channels.filter((item) => item !== origin), active: wasActive ? null : current.active }, wasActive);
}

/** Selects a channel (null for the page origin) and reloads onto it. */
export function selectChannel(origin: string | null): void {
  const current = state();
  if (current.active === origin || (origin !== null && !current.channels.includes(origin))) return;
  switchTo({ ...current, active: origin }, true);
}

/**
 * Records the identity a response reported. The page origin defines the
 * identity and may adopt a new one (its offline data then resets as before);
 * another channel must match it. Returns false for a mismatch.
 */
export function acceptServerId(id: string | null): boolean {
  if (!id) return true;
  const current = state();
  if (current.boundServerId === id) return true;
  if (current.active && current.boundServerId) { store.set({ mismatch: true }); return false; }
  write({ ...current, boundServerId: id });
  return true;
}

/** Forgets the bound identity so a channel of a different server can be used. */
export function resetServerBinding(): void {
  write({ ...state(), boundServerId: null });
  store.set({ mismatch: false });
  checked = undefined;
}

let checked: Promise<boolean> | undefined;
/**
 * Verifies once per page load that the active channel serves the bound
 * identity before any business request leaves. Network failures stay
 * retryable; the page origin needs no check.
 */
export function ensureChannelReady(): Promise<boolean> {
  if (!apiBase()) return Promise.resolve(true);
  checked ??= (async () => {
    const response = await fetch(apiUrl("/api/identity"), { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`Server identity is unavailable (${response.status})`);
    const { id } = await response.json() as { id?: unknown };
    return acceptServerId(typeof id === "string" ? id : null);
  })().catch((error: unknown) => { checked = undefined; throw error; });
  return checked;
}

window.addEventListener("storage", (event) => {
  if (event.key === SERVER_CHANNELS_KEY || event.key === null) {
    volatile = undefined;
    const previous = state().active;
    store.set({ ...readState(), saved: true });
    checked = undefined;
    // Another tab switched channels: this page's sessions and streams belong to the old one.
    if (state().active !== previous) location.reload();
  }
});
