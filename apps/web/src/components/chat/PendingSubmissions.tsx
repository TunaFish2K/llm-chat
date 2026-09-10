import { useEffect } from "react";
import { ActionButton } from "../../lib/action-feedback";
import { submissionStore, restoreSubmissions, reconcileSubmission, submitPending, forgetSubmission } from "../../lib/message-submissions";
import { useStore } from "../../lib/store";
import { appStore } from "../../lib/app-state";

export function PendingSubmissions({ conversationId }: { conversationId: string | null }) {
  const items = useStore(submissionStore, (state) => state.items);
  const messages = useStore(appStore, (state) => conversationId ? state.messages[conversationId] : undefined);
  useEffect(() => {
    restoreSubmissions();
    const reconcile = () => {
      for (const item of submissionStore.get().items) if (item.status === "unknown" || item.status === "accepted") void reconcileSubmission(item.id).catch(() => undefined);
    };
    reconcile();
    window.addEventListener("online", reconcile);
    return () => window.removeEventListener("online", reconcile);
  }, []);
  useEffect(() => {
    for (const item of items) if (messages?.some((message) => message.clientRequestId === item.id || message.id === item.receipt?.userMessageId)) forgetSubmission(item.id);
  }, [messages, items]);
  return <>{items.filter((item) => (item.receipt?.conversationId ?? item.scope) === conversationId &&
    !messages?.some((message) => message.clientRequestId === item.id || message.id === item.receipt?.userMessageId)).map((item) =>
    <article className="msg" key={item.id} aria-label="正在提交的消息">
      <p className="submission-preview">{item.text || "附件消息"}</p>
      {item.draft.attachments.map((asset) => <span key={asset.id}>{asset.kind === "image" ? <img width={96} src={asset.url} alt={asset.fileName} /> : asset.fileName}</span>)}
      <p className="submission-status" role="status">{{ preparing: "正在准备发送…", sending: item.kind === "queue" ? "正在加入队列…" : "发送中…", accepted: "已接受，正在同步记录…", failed: "发送失败", unknown: "发送结果未确认" }[item.status]}</p>
      {item.error ? <p role="alert">{item.error}</p> : null}
      {item.status === "unknown" && item.input ? <ActionButton onClick={() => submitPending(item.id)}>安全重试</ActionButton> : null}
      {item.status === "accepted" ? <ActionButton onClick={() => reconcileSubmission(item.id)}>刷新记录</ActionButton> : null}
      {item.status === "failed" || (item.status === "unknown" && !item.input) ? <ActionButton onClick={() => window.dispatchEvent(new CustomEvent("llm-chat:restore-submission", { detail: item.id }))}>恢复到输入框</ActionButton> : null}
    </article>)}</>;
}
