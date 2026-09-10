import type { AppEvent, GenerationEvent } from "@llm-chat/contracts";

export interface Subscription {
  close(): void;
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

  const connect = () => {
    if (closed) return;
    source = new EventSource(`/api/generations/${generationId}/events`);
    let terminal = false;
    const types = ["snapshot", "block-delta", "usage", "tool-call", "vision-analysis", "status", "error"] as const;
    for (const type of types) {
      source.addEventListener(type, (raw) => {
        const event = JSON.parse((raw as MessageEvent).data as string) as GenerationEvent;
        if (event.type === "status" && ["waiting-approval", "completed", "stopped", "failed", "interrupted"].includes(event.status)) {
          terminal = true;
        }
        onEvent(event);
      });
    }
    source.onopen = () => {
      attempts = 0;
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed || terminal) return;
      onDisconnect?.();
      const delay = Math.min(8_000, 500 * 2 ** attempts);
      attempts += 1;
      reconnectTimer = setTimeout(connect, delay);
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
  const source = new EventSource("/api/events");
  const types = ["task", "task-output", "plugin", "skill", "resource-changed", "image-generation", "message-queue", "generation-state", "generation-snapshot"] as const;
  for (const type of types) {
    source.addEventListener(type, (raw) => {
      const message = raw as MessageEvent;
      onEvent(JSON.parse(message.data as string) as AppEvent);
    });
  }
  source.onopen = () => onStateChange?.(true);
  source.onerror = () => {
    // The browser retries automatically with the last received event id.
    onStateChange?.(false);
  };

  return {
    close() {
      if (closed) return;
      closed = true;
      source.close();
    }
  };
}
