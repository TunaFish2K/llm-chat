import type { AppEvent, GenerationDto, GenerationNotificationState } from "@llm-chat/contracts";
import { generationNotices } from "./notification-protocol";

type State = GenerationNotificationState;
const active = (state: State) => ["queued", "running", "waiting-approval"].includes(state.status);

export class NotificationTracker {
  private sourceId = "";
  private cursor = -1;
  private observed = new Map<string, State>();
  constructor(
    private readonly deliver: (sourceId: string, state: State, notify: boolean) => void,
    private readonly read: (id: string) => Promise<GenerationDto>
  ) {}

  reset(): void { this.sourceId = ""; this.cursor = -1; this.observed.clear(); }
  forget(ids: string[]): void {
    for (const [id, state] of this.observed) if (ids.includes(state.conversationId)) this.observed.delete(id);
  }

  handle(event: AppEvent): void {
    if (event.type === "generation-state") {
      if (!this.sourceId || event.id <= this.cursor) return;
      this.cursor = event.id;
      this.accept(event.generation, true);
    } else if (event.type === "generation-snapshot") {
      const reconnect = this.sourceId === event.sourceId;
      if (!reconnect) this.reset();
      this.sourceId = event.sourceId;
      this.cursor = event.id;
      const currentIds = new Set(event.active.map((state) => state.generationId));
      for (const previous of this.observed.values()) {
        if (currentIds.has(previous.generationId) || !active(previous)) continue;
        const source = this.sourceId;
        void this.read(previous.generationId).then((generation) => {
          // A live event, deletion, logout or new server may have superseded this read.
          if (this.sourceId !== source || this.observed.get(previous.generationId) !== previous) return;
          this.accept({ ...previous, status: generation.status, stopReason: generation.stopReason,
            pendingTools: generation.toolCalls.filter((call) => call.approvalState === "pending")
              .map(({ id, name, stepIndex }) => ({ id, name, stepIndex })) }, true);
        }).catch(() => { /* Retry reconciliation at the next connection. */ });
      }
      for (const state of event.active) this.accept(state, reconnect);
    }
  }

  private accept(state: State, allowNotification: boolean): void {
    const previous = this.observed.get(state.generationId);
    const oldKeys = previous ? new Set(generationNotices(this.sourceId, previous).map((notice) => notice.key)) : new Set<string>();
    const notify = allowNotification && generationNotices(this.sourceId, state).some((notice) => !oldKeys.has(notice.key));
    this.observed.set(state.generationId, state);
    if (this.observed.size > 1000) {
      for (const [id, value] of this.observed) {
        if (!active(value)) this.observed.delete(id);
        if (this.observed.size <= 1000) break;
      }
    }
    this.deliver(this.sourceId, state, notify);
  }
}
