import { useSearchNavigation } from "./useSearchNavigation";
import { Highlight } from "./Highlight";
import { useErrorState } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { conversationDeleted } from "../lib/conversation-lifecycle";
import { offlineStore } from "../lib/offline-history";
import { useEffect, useRef, useState } from "react";
import { endpoints } from "../lib/api";
import { appStore, browseOfflineBranch, refreshConversations, selectBranchImmediately, toastError } from "../lib/app-state";
import { resolveConversationRoot } from "../lib/conversation-tree";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { Modal } from "../lib/ui";

export function ConversationSearch({ onClose, onNavigate = navigate }: { onClose: () => void; onNavigate?: (path: string) => void }) {
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof endpoints.searchConversations>>>([]);
  const [error, setError] = useErrorState(null);
  const [loading, setLoading] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState("");
  const resultsCurrent = resolvedQuery === query.trim();
  const input = useRef<HTMLInputElement>(null);
  const conversations = useStore(appStore, (state) => state.conversations);
  useEffect(() => { if (!window.matchMedia("(pointer: coarse)").matches) input.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true; setError("");
    if (!query.trim()) { setItems([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void endpoints.searchConversations(query.trim(), controller.signal).then((result) => { if (alive) { setItems(result.filter((item) => !conversationDeleted(item.conversationId))); setResolvedQuery(query.trim()); } })
      .catch((cause) => { if (alive) setError(cause.message ?? t("ConversationSearch.search_failed")); }).finally(() => { if (alive) setLoading(false); }); }, 180);
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [query, offline]);
  useEffect(() => {
    const remove = () => { setItems((current) => current.filter((item) => !conversationDeleted(item.conversationId))); };
    window.addEventListener("llm-chat:conversations-deleted", remove);
    return () => window.removeEventListener("llm-chat:conversations-deleted", remove);
  }, []);
  const open = async (id: string) => {
    if (loading || !resultsCurrent) return;
    if (conversationDeleted(id)) return;
    browseOfflineBranch(id); onClose(); onNavigate(routes.chat(id));
    window.dispatchEvent(new Event("llm-chat:reveal-conversation"));
    try {
      const conversation = conversations.find((item) => item.id === id);
      if (conversation) await selectBranchImmediately(resolveConversationRoot(conversation, conversations).id, id);
      void refreshConversations().catch(toastError);
    } catch (cause) { toastError(cause); }
  };
  const navigation = useSearchNavigation({ ids: items.map(item => item.conversationId), query,
    ready: !loading && resultsCurrent, onSelect: id => void open(id) });
  return <Modal title={t("WorkspaceSidebar.search_conversations")} onClose={onClose} wide>
    <div className="conversation-search-dialog">
      <input ref={input} className="input" type="search" aria-label={t("ConversationSearch.search_conversation_titles_and_messages")} placeholder={t("ConversationSearch.search_titles_or_message_content")} maxLength={200} value={query}
        {...navigation.inputProps} onChange={(event) => setQuery(event.target.value)} />
      {offline ? <p className="hint">{t("detail.searching_records_synced_to_this_device")}</p> : null}
      {loading ? <p role="status">{t("ConversationSearch.searching")}</p> : error ? <p role="alert">{error}</p> : query.trim() && !items.length ? <p>{t("ConversationSearch.no_matching_conversations")}</p> : null}
      <div id={navigation.listId} role="listbox" aria-label={t("WorkspaceSidebar.search_conversations")} className="conversation-search-results" inert={loading || !resultsCurrent ? true : undefined} aria-busy={loading}>{items.map((item) => <button {...navigation.optionProps(item.conversationId)} className="conversation-search-result" key={item.conversationId}
        onClick={() => void open(item.conversationId)}><strong><Highlight text={item.title} query={query} /></strong>
        <span><Highlight text={item.snippet || t("ConversationSearch.title_match")} query={query} /></span></button>)}</div>
    </div>
  </Modal>;
}
