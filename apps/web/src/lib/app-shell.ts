import shellProtocol from "../app-shell-protocol.json";
import { readShellState, updateShellState } from "./shell-db";

/**
 * The service worker owns the application shell instead of the browser's
 * precache, so any channel of the same server can deliver an update. Every
 * file is verified by SRI, and responses are re-created so cached documents
 * belong to the page origin rather than the channel they came from.
 */
export const SHELL_PROTOCOL: number = shellProtocol.protocol;
export const SHELL_CACHE_PREFIX = "llm-chat-shell-";
const STAGING_PREFIX = `${SHELL_CACHE_PREFIX}staging-`;
const DOWNLOAD_TIMEOUT = 90_000;
// Cross-origin responses expose these only because the server lists them.
const KEPT_HEADERS = ["content-type", "content-security-policy", "cross-origin-opener-policy", "origin-agent-cluster",
  "referrer-policy", "x-content-type-options", "x-frame-options"];

export interface ShellEntry { url: string; integrity: string }
export interface ShellManifest { id: string; protocol: number; entries: ShellEntry[] }
export interface ShellState { current: ShellManifest | null; previous: ShellManifest | null; staged: ShellManifest | null }
export type ShellInstallResult = { status: "current" | "staged"; id: string } | { status: "protocol"; protocol: number };

/** Keep in sync with scripts/write-app-shell.mjs. */
export async function shellId(protocol: number, entries: readonly ShellEntry[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ protocol, entries: entries.map(({ url, integrity }) => ({ url, integrity })) }));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function parseShellManifest(value: unknown): Promise<ShellManifest> {
  const record = value as Partial<ShellManifest> | null;
  const valid = record && typeof record.id === "string" && /^[\da-f]{64}$/.test(record.id)
    && Number.isInteger(record.protocol) && Array.isArray(record.entries)
    && record.entries.every((entry) => typeof entry?.url === "string" && /^\/(?!\/)[^?#]*$/.test(entry.url)
      && typeof entry.integrity === "string" && entry.integrity.startsWith("sha256-"));
  if (!valid) throw new Error("The app shell manifest is invalid");
  const manifest = { id: record.id!, protocol: record.protocol!, entries: record.entries!.map(({ url, integrity }) => ({ url, integrity })) };
  if (manifest.protocol === SHELL_PROTOCOL && await shellId(manifest.protocol, manifest.entries) !== manifest.id) {
    throw new Error("The app shell manifest is invalid");
  }
  return manifest;
}

// Fetches read the memoized state; installing and activating re-read it
// because a waiting worker shares the database with the active one.
let memo: Promise<ShellState> | undefined;
function shellState(fresh = false): Promise<ShellState> {
  if (fresh) memo = undefined;
  memo ??= readShellState().catch((error) => { memo = undefined; throw error; });
  return memo;
}
async function changeShellState(change: (state: ShellState) => ShellState): Promise<ShellState> {
  try { return await updateShellState(change); }
  finally { memo = undefined; }
}

async function shellResponse(response: Response): Promise<Response> {
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(await response.arrayBuffer(), { status: 200, headers });
}

async function download(base: string, manifest: ShellManifest, signal: AbortSignal): Promise<void> {
  const stagingName = `${STAGING_PREFIX}${crypto.randomUUID()}`;
  try {
    const staging = await caches.open(stagingName);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, manifest.entries.length) }, async () => {
      while (next < manifest.entries.length) {
        const entry = manifest.entries[next++]!;
        const response = await fetch(new URL(entry.url, base).href, {
          cache: "reload", mode: "cors", credentials: "omit", integrity: entry.integrity, signal
        });
        if (!response.ok) throw new Error(`Resource download failed (${response.status})`);
        await staging.put(entry.url, await shellResponse(response));
      }
    }));
    const target = await caches.open(SHELL_CACHE_PREFIX + manifest.id);
    for (const entry of manifest.entries) {
      const response = await staging.match(entry.url);
      if (!response) throw new Error("Downloaded resource is missing");
      await target.put(entry.url, response);
    }
  } finally {
    await caches.delete(stagingName);
  }
}

/**
 * Downloads the shell published by `base` unless it is already current or
 * staged. `force` re-downloads it to repair evicted or corrupted files.
 */
export async function installShell(base: string, options: { force?: boolean } = {}): Promise<ShellInstallResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("App shell download timed out")), DOWNLOAD_TIMEOUT);
  try {
    const response = await fetch(new URL("/app-shell.json", base).href, {
      cache: "no-store", mode: "cors", credentials: "omit", signal: abort.signal
    });
    if (!response.ok) throw new Error(`App shell manifest download failed (${response.status})`);
    const manifest = await parseShellManifest(await response.json());
    if (manifest.protocol !== SHELL_PROTOCOL) return { status: "protocol", protocol: manifest.protocol };
    const state = await shellState(true);
    if (!options.force && state.current?.id === manifest.id) return { status: "current", id: manifest.id };
    if (!options.force && state.staged?.id === manifest.id) return { status: "staged", id: manifest.id };
    await download(base, manifest, abort.signal);
    const next = await changeShellState((latest) => latest.current?.id === manifest.id ? latest : { ...latest, staged: manifest });
    return { status: next.current?.id === manifest.id ? "current" : "staged", id: manifest.id };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Makes a staged shell current, keeping the previous one for pages still running it. */
export async function activateShell(id: string): Promise<void> {
  const next = await changeShellState((state) => {
    if (state.current?.id === id) return state;
    if (state.staged?.id !== id) throw new Error("The app shell update is no longer available");
    return { current: state.staged, previous: state.current, staged: null };
  });
  await pruneShellCaches(next);
}

/** Runs when a new worker activates: adopts the shell it installed and drops stale caches. */
export async function activateStagedShell(): Promise<void> {
  const state = await shellState(true);
  if (state.staged?.protocol === SHELL_PROTOCOL) await activateShell(state.staged.id);
  else if (state.staged) await changeShellState((latest) => ({ ...latest, staged: null }));
  const next = await shellState();
  await pruneShellCaches(next, true);
}

async function pruneShellCaches(state: ShellState, staging = false): Promise<void> {
  const keep = new Set([state.current, state.previous, state.staged].filter((item) => item !== null).map((item) => SHELL_CACHE_PREFIX + item.id));
  for (const name of await caches.keys()) {
    const stale = name.startsWith(STAGING_PREFIX) ? staging : name.startsWith(SHELL_CACHE_PREFIX) && !keep.has(name);
    if (stale) await caches.delete(name);
  }
}

/**
 * Finds a shell response for a same-origin request. Navigations always use the
 * current document; other files may come from the previous shell so older
 * pages can still load their lazy chunks.
 */
export async function matchShell(pathname: string, navigate: boolean): Promise<Response | undefined> {
  const state = await shellState();
  const path = pathname === "/" ? "/index.html" : pathname;
  for (const manifest of [state.current, state.previous]) {
    if (!manifest) continue;
    const listed = manifest.entries.some((entry) => entry.url === path);
    const key = listed ? path : navigate && manifest === state.current ? "/index.html" : null;
    if (!key) continue;
    const response = await (await caches.open(SHELL_CACHE_PREFIX + manifest.id)).match(key);
    if (response) return response;
  }
  return undefined;
}
