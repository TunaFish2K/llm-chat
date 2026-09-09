import { isOffline, offlineStore } from "../lib/offline-history";
import { useEffect, useRef, useState } from "react";
import { endpoints } from "../lib/api";
import { appStore, browseOfflineBranch, refreshConversations, toastError } from "../lib/app-state";
import { resolveConversationRoot } from "../lib/conversation-tree";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { Modal } from "../lib/ui";

export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts = []; let start = 0;
  const normalized = text.toLocaleLowerCase(), needle = query.trim().toLocaleLowerCase();
  for (let i = normalized.indexOf(needle); i >= 0; i = normalized.indexOf(needle, start)) {
    parts.push(text.slice(start, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>); start = i + needle.length;
  }
  parts.push(text.slice(start)); return <>{parts}</>;
}
export function ConversationSearch({ onClose }: { onClose: () => void }) {
  const offline = useStore(offlineStore, (state) => state.offline);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof endpoints.searchConversations>>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => { results.current?.querySelector('[data-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [selected]);
  const conversations = useStore(appStore, (state) => state.conversations);
  useEffect(() => { if (!window.matchMedia("(pointer: coarse)").matches) input.current?.focus(); }, []);
  useEffect(() => {
    let alive = true; setSelected(0); setError(""); setItems([]);
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void endpoints.searchConversations(query.trim()).then((result) => { if (alive) setItems(result); })
      .catch((cause) => { if (alive) setError(cause.message ?? "搜索失败"); }).finally(() => { if (alive) setLoading(false); }); }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, offline]);
  const open = async (id: string) => {
    try {
      if (isOffline()) { browseOfflineBranch(id); onClose(); navigate(routes.chat(id)); return; }
      const conversation = conversations.find((item) => item.id === id);
      if (conversation) await endpoints.selectConversationBranch(resolveConversationRoot(conversation, conversations).id, id);
      await refreshConversations(); onClose(); navigate(routes.chat(id));
      window.dispatchEvent(new Event("llm-chat:reveal-conversation"));
    } catch (cause) { toastError(cause); }
  };
  return <Modal title="搜索会话" onClose={onClose} wide>
    <div className="conversation-search-dialog">
      <input ref={input} className="input" type="search" aria-label="搜索会话标题与正文" placeholder="搜索标题或消息内容" maxLength={200} value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((n) => Math.max(0, Math.min(items.length - 1, n + (event.key === "ArrowDown" ? 1 : -1)))); }
          if (event.key === "Enter" && items[selected]) { event.preventDefault(); void open(items[selected]!.conversationId); }
        }} />
      <p className="hint">{offline ? "正在搜索本机已同步的记录。" : ""}标题匹配优先，其次按最近更新排序。最多显示 50 个会话。</p>
      {loading ? <p role="status">搜索中…</p> : error ? <p role="alert">{error}</p> : query.trim() && !items.length ? <p>没有匹配的会话。</p> : null}
      <div ref={results} className="conversation-search-results">{items.map((item, index) => <button className="conversation-search-result" data-selected={index === selected || undefined} key={item.conversationId}
        onClick={() => void open(item.conversationId)}><strong><Highlight text={item.title} query={query} /></strong>
        <span><Highlight text={item.snippet || "标题匹配"} query={query} /></span></button>)}</div>
    </div>
  </Modal>;
}
