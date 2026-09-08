import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { QueuedMessageDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { loadMessages, toastError } from "../../lib/app-state";

export function useMessageQueue(conversationId?: string) {
  const [items, setItems] = useState<QueuedMessageDto[]>([]);
  const current = useRef(conversationId);
  current.current = conversationId;
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const id = ++revision.current;
    if (!conversationId) { setItems([]); return; }
    const next = await endpoints.queuedMessages(conversationId);
    if (current.current === conversationId && revision.current === id) setItems(Array.isArray(next) ? next : []);
  }, [conversationId]);
  useEffect(() => {
    setItems([]);
    void reload().catch(toastError);
    const update = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.conversationId !== conversationId) return;
      void reload().catch(toastError);
      if (conversationId) void loadMessages(conversationId).catch(toastError);
    };
    window.addEventListener("llm-chat:message-queue", update);
    window.addEventListener("llm-chat:queue-reconnect", update);
    const resume = () => { if (document.visibilityState === "visible") update(new Event("resume")); };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => { revision.current++; window.removeEventListener("llm-chat:message-queue", update); window.removeEventListener("llm-chat:queue-reconnect", update);
      window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", resume); };
  }, [reload, conversationId]);
  useEffect(() => {
    if (!items.length) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void reload().catch(toastError); }, 5000);
    return () => window.clearInterval(timer);
  }, [items.length, reload]);
  return { items, reload };
}

export function MessageQueueList({ conversationId, items, reload, paused = false }: {
  conversationId: string | undefined; items: QueuedMessageDto[]; reload: () => Promise<void>; paused?: boolean;
}) {
  if (!conversationId || !items.length) return null;
  const remove = async (id?: string) => {
    try { await endpoints.deleteQueuedMessage(conversationId, id); await reload(); } catch (error) { toastError(error); }
  };
  return <section className="message-queue" aria-label="待发送消息">
    {paused ? <div className="row"><span>回溯后已暂停自动发送</span><button className="btn small" onClick={() => void endpoints.resumeQueue(conversationId).then(reload).catch(toastError)}>继续发送</button></div> : null}
    <header><span>待发送 · {items.length}</span><button type="button" className="icon-button" aria-label="清空待发送消息" onClick={() => void remove()}><Trash2 size={15} /></button></header>
    <ol>{items.map((item) => <li key={item.id}>
      <div><p>{item.text || "附件消息"}</p>{item.attachments.length ? <small>{item.attachments.length} 个附件</small> : null}
        {item.status === "dispatching" ? <small>正在发送</small> : item.error ? <small role="alert">{item.error}</small> : null}</div>
      <button type="button" className="icon-button" disabled={item.status === "dispatching"} aria-label={`删除待发送消息 ${item.text || "附件消息"}`} onClick={() => void remove(item.id)}><X size={15} /></button>
    </li>)}</ol>
  </section>;
}
