import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationHistoryDto, HistoryChangeInput, MessageDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, loadMessages, refreshConversations, toast, toastError } from "../../lib/app-state";
import { useStore } from "../../lib/store";
import { navigate, routes } from "../../lib/router";
import { Modal } from "../../lib/ui";
import { Markdown } from "../../lib/markdown";
import { AssetGallery } from "./atoms";
import { answerText, activeGeneration } from "./model";

export function useConversationHistory(conversationId?: string) {
  const [state, setState] = useState<ConversationHistoryDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const current = useRef(conversationId); current.current = conversationId;
  const request = useRef(0);
  const reload = useCallback(async () => {
    const revision = ++request.current;
    if (!conversationId) { setState(null); return; }
    const next = await endpoints.conversationHistory(conversationId);
    if (current.current === conversationId && request.current === revision) setState(next && typeof next.revision === "number" ? next : null);
  }, [conversationId]);
  const perform = useCallback(async (action: HistoryChangeInput["action"], throughMessageId?: string) => {
    if (!conversationId || !state || busy) return;
    setBusy(true);
    try {
      await endpoints.changeHistory(conversationId, { action, revision: state.revision, ...(throughMessageId ? { throughMessageId } : {}) });
      await Promise.all([loadMessages(conversationId), refreshConversations(), reload()]);
      window.dispatchEvent(new CustomEvent("llm-chat:message-queue", { detail: { conversationId } }));
      window.dispatchEvent(new Event("llm-chat:context-summary"));
      toast("success", action === "redo" ? "已恢复原消息和回复" : "已撤回，可以重做");
    } catch (error) { toastError(error); await reload().catch(() => {}); }
    finally { setBusy(false); }
  }, [conversationId, state, busy, reload]);
  useEffect(() => {
    setState(null); setOpen(false);
    void reload().catch(toastError);
    const update = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.conversationId !== conversationId) return;
      void reload().catch(toastError);
    };
    window.addEventListener("llm-chat:message-queue", update);
    window.addEventListener("llm-chat:queue-reconnect", update);
    return () => { request.current++; window.removeEventListener("llm-chat:message-queue", update); window.removeEventListener("llm-chat:queue-reconnect", update); };
  }, [reload, conversationId]);
  useEffect(() => {
    const rewind = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.conversationId === conversationId) void perform("rewind", detail.messageId);
    };
    window.addEventListener("llm-chat:rewind", rewind);
    return () => window.removeEventListener("llm-chat:rewind", rewind);
  }, [perform, conversationId]);
  return { state, busy, open, setOpen, reload, perform };
}

export function RecoveryDialog({ state, onClose, onRestore }: {
  state: ConversationHistoryDto; onClose: () => void; onRestore: (message: MessageDto) => void;
}) {
  const conversations = useStore(appStore, (app) => app.conversations);
  const copy = async (message: MessageDto) => {
    try {
      await navigator.clipboard.writeText(message.text ?? (activeGeneration(message) ? answerText(activeGeneration(message)!) : ""));
      toast("success", "已复制");
    } catch (error) { toastError(error); }
  };
  return <Modal title="恢复记录" onClose={onClose} wide>
    <p className="hint">这里只恢复对话内容，不回滚工作区文件。恢复为草稿后需手动发送。</p>
    {!state.records.length ? <p>没有撤回记录。</p> : null}
    {state.records.map((record) => <section key={record.id} className="card recovery-record">
      <h3>{new Date(record.createdAt).toLocaleString()} {record.redo ? "· 可重做" : ""}</h3>
      {record.messages.map((message) => <div key={message.id} className="recovery-message">
        <strong>{message.role === "user" ? "用户" : "助手"}</strong>
        <Markdown text={message.text ?? (activeGeneration(message) ? answerText(activeGeneration(message)!) : "")} />
        <AssetGallery assets={message.attachments} />
        <div className="row">
          <button className="btn small" onClick={() => void copy(message)}>复制内容</button>
          {message.role === "user" ? <button className="btn small" onClick={() => onRestore(message)}>恢复为草稿</button> : null}
          {conversations.filter((conversation) => conversation.forkedFrom?.messageId === message.id).map((conversation) =>
            <button className="btn small" key={conversation.id} onClick={() => void endpoints.selectConversationBranch(conversation.forkedFrom!.conversationId, conversation.id)
              .then(async () => { await refreshConversations(); onClose(); navigate(routes.chat(conversation.id)); }).catch(toastError)}>打开分支：{conversation.title}</button>)}
        </div>
      </div>)}
    </section>)}
  </Modal>;
}
