import { createHash } from "node:crypto";
import type { Store, SubmissionInput } from "./database";
import { StoreError } from "./errors";

/** Serializes duplicate requests through asynchronous attachment preparation as well as the SQL commit. */
export class MessageSubmissions {
  private readonly active = new Map<string, { hash: string; promise: Promise<unknown> }>();
  constructor(private readonly store: Store) {}

  run<T, V extends { clientRequestId?: string | undefined }>(kind: SubmissionInput["kind"], target: string | null, value: V,
    action: (input: SubmissionInput | undefined) => Promise<T>): Promise<T> {
    if (!value.clientRequestId) return action(undefined);
    const input: SubmissionInput = { id: value.clientRequestId, kind,
      hash: createHash("sha256").update(JSON.stringify(canonical({ kind, target, value }))).digest("hex") };
    const active = this.active.get(input.id);
    if (active) {
      if (active.hash !== input.hash) return Promise.reject(new StoreError("submission_conflict", "请求标识已用于不同的提交内容"));
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(() => {
      const receipt = this.store.getSubmission(input.id, input);
      if (!receipt) return action(input);
      if (receipt.deleted) throw new StoreError("submission_deleted", "此次提交的记录已删除");
      const generation = { userMessageId: receipt.userMessageId!, assistantMessageId: receipt.assistantMessageId!, generationId: receipt.generationId! };
      if (kind === "start") return { conversation: this.store.getConversation(receipt.conversationId)!, generation } as T;
      if (kind === "send") return generation as T;
      const queued = this.store.listQueuedMessages(receipt.conversationId).find((item) => item.id === receipt.queuedMessageId);
      if (queued) return queued as T;
      const message = this.store.listMessages(receipt.conversationId).find((item) => item.id === receipt.userMessageId)!;
      return { id: receipt.queuedMessageId!, conversationId: receipt.conversationId, clientRequestId: receipt.clientRequestId,
        text: message.text ?? "", attachments: message.attachments, createdAt: message.createdAt,
        status: "dispatching", error: null, generationId: receipt.generationId } as T;
    }).finally(() => { this.active.delete(input.id); });
    this.active.set(input.id, { hash: input.hash, promise });
    return promise;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
