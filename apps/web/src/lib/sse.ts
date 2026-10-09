import type { AppEvent, GenerationEvent } from "@llm-chat/contracts";
import { apiBase, apiUrl, ensureChannelReady } from "./server-channel";

export interface Subscription {
  close(): void;
}

/**
 * Streams open only after the active channel proved its server identity; the
 * page origin opens synchronously. A mismatch never opens: HTTP requests
 * report it. Other failures go to `retry`.
 */
function whenChannelReady(open: () => void, retry: () => void): void {
  if (!apiBase()) { open(); return; }
  ensureChannelReady().then((matches) => { if (matches) open(); }, retry);
}

function eventSource(path: string): EventSource {
  return apiBase() ? new EventSource(apiUrl(path), { withCredentials: true }) : new EventSource(path);
}

/**
 * Subscribes to a generation's SSE stream. The server sends a full snapshot
 * first, then deltas, and closes the stream when the generation reaches a
 * terminal state. Automatically reconnects while the generation is active.
 */
export function subscribeGeneration(
  generationId: string,
  onEvent: (event: GenerationEvent) => void,
  onDisconnect?: () => void
): Subscription {
  let closed = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const reconnect = () => {
    onDisconnect?.();
    const delay = Math.min(8_000, 500 * 2 ** attempts);
    attempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  };
  const connect = () => {
    if (!closed) whenChannelReady(open, () => { if (!closed) reconnect(); });
  };
  const open = () => {
    if (closed) return;
    const current = eventSource(`/api/generations/${generationId}/events`);
    source = current;
    let terminal = false;
    const types = ["snapshot", "block-delta", "block-append", "usage", "tool-call", "vision-analysis", "status", "error"] as const;
    for (const type of types) {
      source.addEventListener(type, (raw) => {
        // Native connection errors have no data; only named SSE messages carry JSON.
        if (closed || source !== current || !(raw instanceof MessageEvent)) return;
        const event = JSON.parse((raw as MessageEvent).data as string) as GenerationEvent;
        const status = event.type === "status" ? event.status : event.type === "snapshot" ? event.generation.status : undefined;
        if (status && ["waiting-approval", "completed", "stopped", "failed", "interrupted"].includes(status)) {
          terminal = true;
        }
        onEvent(event);
      });
    }
    source.onopen = () => {
      if (closed || source !== current) return;
      attempts = 0;
    };
    source.onerror = () => {
      if (closed || source !== current) return;
      source?.close();
      source = null;
      if (closed || terminal) return;
      reconnect();
    };
  };
  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    }
  };
}

/**
 * Subscribes to the app-wide event stream (background tasks, plugins, skills).
 * The native EventSource auto-reconnects and replays from the browser-managed
 * Last-Event-ID, preserving the server's event replay semantics; we never
 * close/recreate the source on transient errors.
 */
export function subscribeAppEvents(
  onEvent: (event: AppEvent) => void,
  onStateChange?: (connected: boolean) => void
): Subscription {
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const types = ["submission-accepted", "container-resource", "resync", "task", "task-output", "plugin", "skill", "resource-changed", "image-generation", "image-session-generation", "message-queue", "generation-state", "generation-snapshot"] as const;
  const open = () => {
    if (closed) return;
    const current = eventSource("/api/events");
    source = current;
    for (const type of types) {
      current.addEventListener(type, (raw) => {
        if (closed) return;
        const message = raw as MessageEvent;
        onEvent(JSON.parse(message.data as string) as AppEvent);
      });
    }
    current.onopen = () => { if (!closed) onStateChange?.(true); };
    current.onerror = () => {
      // The browser retries automatically with the last received event id.
      if (!closed) onStateChange?.(false);
    };
  };
  const connect = () => whenChannelReady(open, () => {
    if (closed) return;
    onStateChange?.(false);
    retryTimer = setTimeout(connect, 3_000);
  });
  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      source?.close();
    }
  };
}
