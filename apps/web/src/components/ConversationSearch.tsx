import { useErrorState } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { conversationDeleted } from "../lib/conversation-lifecycle";
import { isOffline, offlineStore } from "../lib/offline-history";
import { useEffect, useRef, useState } from "react";
import { endpoints } from "../lib/api";
import { appStore, browseOfflineBranch, refreshConversations, toastError } from "../lib/app-state";
import { resolveConversationRoot } from "../lib/conversation-tree";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { Modal } from "../lib/ui";

export function Highlight({ text, query }: { text: string; query: string }) {
  useLocale();
  if (!query.trim()) return <>{text}</>;
  const parts = []; let start = 0;
  const normalized = text.toLocaleLowerCase(), needle = query.trim().toLocaleLowerCase();
  for (let i = normalized.indexOf(needle); i >= 0; i = normalized.indexOf(needle, start)) {
    parts.push(text.slice(start, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>); start = i + needle.length;
  }
  parts.push(text.slice(start)); return <>{parts}</>;
}
export function ConversationSearch({ onClose }: { onClose: () => void }) {
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof endpoints.searchConversations>>>([]);
  const [error, setError] = useErrorState(null);
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
    const timer = setTimeout(() => { void endpoints.searchConversations(query.trim()).then((result) => { if (alive) setItems(result.filter((item) => !conversationDeleted(item.conversationId))); })
      .catch((cause) => { if (alive) setError(cause.message ?? t("ConversationSearch.search_failed")); }).finally(() => { if (alive) setLoading(false); }); }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, offline]);
  useEffect(() => {
    const remove = () => { setItems((current) => current.filter((item) => !conversationDeleted(item.conversationId))); setSelected(0); };
    window.addEventListener("llm-chat:conversations-deleted", remove);
    return () => window.removeEventListener("llm-chat:conversations-deleted", remove);
  }, []);
  const open = async (id: string) => {
    if (conversationDeleted(id)) return;
    try {
      if (isOffline()) { browseOfflineBranch(id); onClose(); navigate(routes.chat(id)); return; }
      const conversation = conversations.find((item) => item.id === id);
      if (conversation) await endpoints.selectConversationBranch(resolveConversationRoot(conversation, conversations).id, id);
      await refreshConversations(); onClose(); if (!conversationDeleted(id)) navigate(routes.chat(id));
      window.dispatchEvent(new Event("llm-chat:reveal-conversation"));
    } catch (cause) { toastError(cause); }
  };
  return <Modal title={t("WorkspaceSidebar.search_conversations")} onClose={onClose} wide>
    <div className="conversation-search-dialog">
      <input ref={input} className="input" type="search" aria-label={t("ConversationSearch.search_conversation_titles_and_messages")} placeholder={t("ConversationSearch.search_titles_or_message_content")} maxLength={200} value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((n) => Math.max(0, Math.min(items.length - 1, n + (event.key === "ArrowDown" ? 1 : -1)))); }
          if (event.key === "Enter" && items[selected]) { event.preventDefault(); void open(items[selected]!.conversationId); }
        }} />
      <p className="hint">{t("ConversationSearch.title_matches_come_first_then_recently_updated_conversations_shows_up", { value1: (offline ? t("detail.searching_records_synced_to_this_device") : "") })}</p>
      {loading ? <p role="status">{t("ConversationSearch.searching")}</p> : error ? <p role="alert">{error}</p> : query.trim() && !items.length ? <p>{t("ConversationSearch.no_matching_conversations")}</p> : null}
      <div ref={results} className="conversation-search-results">{items.map((item, index) => <button className="conversation-search-result" data-selected={index === selected || undefined} key={item.conversationId}
        onClick={() => void open(item.conversationId)}><strong><Highlight text={item.title} query={query} /></strong>
        <span><Highlight text={item.snippet || t("ConversationSearch.title_match")} query={query} /></span></button>)}</div>
    </div>
  </Modal>;
}
