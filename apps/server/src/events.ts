import type { AppEvent } from "@llm-chat/contracts";

type AppEventInput = AppEvent extends infer Event
  ? Event extends AppEvent ? Omit<Event, "id"> : never
  : never;

export class EventHub {
  private nextId = 1;
  private readonly history: AppEvent[] = [];
  private readonly listeners = new Set<(event: AppEvent) => void>();

  get cursor(): number { return this.nextId - 1; }

  emit(event: AppEventInput): AppEvent {
    const stored = { ...event, id: this.nextId++ } as AppEvent;
    this.history.push(stored);
    if (this.history.length > 1_000) this.history.splice(0, this.history.length - 1_000);
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  subscribe(afterId: number, listener: (event: AppEvent) => void): () => void {
    for (const event of this.history) if (event.id > afterId) listener(event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
