import { displayError } from "../../lib/error-display";
import { t, useLocale } from "../../lib/i18n";
import { RefreshScheduler } from "../../lib/refresh-scheduler";
import { conversationDeleted } from "../../lib/conversation-lifecycle";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { QueuedMessageDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { refreshMessages, toastError } from "../../lib/app-state";

export function useMessageQueue(conversationId?: string) {
  useLocale();
  const [items, setItems] = useState<QueuedMessageDto[]>([]);
  const [paused, setPaused] = useState(false);
  const current = useRef(conversationId);
  current.current = conversationId;
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const id = ++revision.current;
    if (!conversationId || conversationDeleted(conversationId)) { setItems([]); setPaused(false); return; }
    const next = await endpoints.queueState(conversationId);
    if (!Array.isArray(next.items) || typeof next.paused !== "boolean") throw new Error(t("MessageQueueList.invalid_message_queue_response"));
    if (!conversationDeleted(conversationId) && current.current === conversationId && revision.current === id) { setItems(next.items); setPaused(next.paused); }
  }, [conversationId]);
  useEffect(() => {
    setItems([]); setPaused(false);
    void reload().catch(toastError);
    const refreshes = new RefreshScheduler(toastError);
    const update = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.conversationId !== conversationId) return;
      refreshes.schedule("queue", reload);
      if (conversationId) refreshMessages(conversationId);
    };
    window.addEventListener("llm-chat:message-queue", update);
    window.addEventListener("llm-chat:queue-reconnect", update);
    const resume = () => { if (document.visibilityState === "visible") update(new Event("resume")); };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { refreshes.clear(); revision.current++; window.removeEventListener("llm-chat:message-queue", update); window.removeEventListener("llm-chat:queue-reconnect", update);
      window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", resume); };
  }, [reload, conversationId]);
  useEffect(() => {
    if (!items.length) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void reload().catch(toastError); }, 5000);
    return () => window.clearInterval(timer);
  }, [items.length, reload]);
  return { items, paused, reload };
}

export function MessageQueueList({ conversationId, items, reload, paused = false }: {
  conversationId: string | undefined; items: QueuedMessageDto[]; reload: () => Promise<void>; paused?: boolean;
}) {
  useLocale();
  if (!conversationId || !items.length) return null;
  const remove = async (id?: string) => {
    try { await endpoints.deleteQueuedMessage(conversationId, id); await reload(); } catch (error) { toastError(error); }
  };
  return <section className="message-queue" aria-label={t("MessageQueueList.queued_messages")}>
    {paused ? <div className="row"><span>{t("MessageQueueList.queue_paused")}</span><button className="btn small" onClick={() => void endpoints.resumeQueue(conversationId).then(reload).catch(toastError)}>{t("MessageQueueList.resume_sending")}</button></div> : null}
    <header><span>{t("MessageQueueList.queued", { value1: (items.length) })}</span><button type="button" className="icon-button" aria-label={t("MessageQueueList.clear_queued_messages")} onClick={() => void remove()}><Trash2 size={15} /></button></header>
    <ol>{items.map((item) => <li key={item.id}>
      <div><p>{item.mode === "steer" ? <span className="tag accent">{t("MessageQueueList.steer_next_request")}</span> : null}{item.text || t("MessageQueueList.message_with_attachments")}</p>{item.attachments.length ? <small>{t("MessageQueueList.attachments", { count: Number((item.attachments.length)), value1: (item.attachments.length) })}</small> : null}
        {item.status === "dispatching" ? <small>{t("MessageQueueList.sending")}</small> : item.error ? <small role="alert">{displayError({ message: item.error, ...(item.errorI18n ? { i18n: item.errorI18n } : {}) })}</small> : null}</div>
      <button type="button" className="icon-button" disabled={item.status === "dispatching"} aria-label={t("MessageQueueList.delete_queued_message", { value1: (item.text || t("MessageQueueList.message_with_attachments")) })} onClick={() => void remove(item.id)}><X size={15} /></button>
    </li>)}</ol>
  </section>;
}
