import { t, useLocale, localized } from "../lib/i18n";
import { conversationDeleted } from "../lib/conversation-lifecycle";
import { offlineStore } from "../lib/offline-history";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConversationDto } from "@llm-chat/contracts";
import {
  Bot,
  Download,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  SquarePen,
  Plus,
  Search,
  Settings,
  Trash2,
  X
} from "lucide-react";
import { endpoints } from "../lib/api";
import { appStore, refreshConversations, toast, toastError } from "../lib/app-state";
import { listConversationFamilies, resolveConversationRoot } from "../lib/conversation-tree";
import { formatTime } from "../lib/format";
import { linkClick, navigate, routes, type Route } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, Modal } from "../lib/ui";
import { useBackLayer } from "../lib/mobile-navigation";
import { Popover } from "radix-ui";
import { ConversationSearch } from "../components/ConversationSearch";
import type { PwaState } from "../lib/pwa";

export function WorkspaceSidebar({
  route,
  compact,
  onClose,
  onToggleCompact,
  pwa,
  onInstall
}: {
  route: Route;
  compact: boolean;
  onClose?: () => void;
  onToggleCompact?: () => void;
  pwa: PwaState;
  onInstall: () => void;
}) {
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const cachedIds = useStore(offlineStore, (state) => state.cachedIds);
  const conversations = useStore(appStore, (state) => state.conversations);
  const [searchOpen, setSearchOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const [renaming, setRenaming] = useState<ConversationDto | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ConversationDto | null>(null);
  const [busy, setBusy] = useState(false);
  const activeConversation = route.name === "chat"
    ? conversations.find((item) => item.id === route.conversationId)
    : undefined;
  const activeId = activeConversation ? resolveConversationRoot(activeConversation, conversations).id : null;
  const families = useMemo(() => listConversationFamilies(conversations), [conversations]);
  const visible = useMemo(() => families
    .map((family) => ({
      ...family.root,
      activeBranchId: family.root.activeBranchId ?? family.root.id,
      updatedAt: family.latestUpdatedAt
    })), [families]);
  const groups = useMemo(() => groupConversations(visible), [visible]);

  useEffect(() => {
    const reveal = () => sidebar.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
    reveal(); window.addEventListener("llm-chat:reveal-conversation", reveal);
    return () => window.removeEventListener("llm-chat:reveal-conversation", reveal);
  }, [activeId, compact]);

  const rename = async () => {
    if (!renaming || !renameValue.trim()) return;
    setBusy(true);
    try {
      await endpoints.updateConversation(renaming.id, { title: renameValue.trim() });
      await refreshConversations();
      setRenaming(null);
      toast("success", localized("WorkspaceSidebar.conversation_renamed"));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await endpoints.deleteConversation(deleting.id).catch((error: unknown) => { if (!conversationDeleted(deleting.id)) throw error; });
      await refreshConversations();
      if (deleting.id === activeId) navigate(routes.chat());
      setDeleting(null);
      toast("success", localized("WorkspaceSidebar.conversation_deleted"));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside ref={sidebar} onClick={(event) => {
      if (event.target instanceof Element && event.target.closest('a[href]') && event.defaultPrevented) onClose?.();
    }} className="workspace-sidebar" data-compact={compact || undefined} aria-label={t("WorkspaceSidebar.main_navigation_and_conversations")}>
      <header className="sidebar-brand">
        {compact ? (
          <button className="sidebar-brand-button" onClick={onToggleCompact} aria-label={t("WorkspaceSidebar.expand_conversation_sidebar")} title={t("WorkspaceSidebar.expand_conversation_sidebar")}>
            <img src="/icons/icon-192-v2.png" width={28} height={28} alt="" />
            <PanelLeftOpen className="sidebar-brand-action" size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            <a href="/" onClick={linkClick("/")} aria-label={t("WorkspaceSidebar.chat_home")}>
              <img src="/icons/icon-192-v2.png" width={28} height={28} alt="" />
              <span>Chat</span>
            </a>
            <div className="sidebar-header-actions"><button className="icon-button" aria-label={t("WorkspaceSidebar.search_conversations")} title={t("WorkspaceSidebar.search_conversations")} onClick={() => setSearchOpen(true)}><Search size={18} /></button>
            {onClose ? (
              <button className="icon-button" onClick={onClose} aria-label={t("App.close_navigation")} title={t("App.close_navigation")}><X size={18} /></button>
            ) : onToggleCompact ? (
              <button className="icon-button sidebar-collapse-button" onClick={onToggleCompact} aria-label={t("WorkspaceSidebar.collapse_conversation_sidebar")} title={t("WorkspaceSidebar.collapse_conversation_sidebar")}><PanelLeftClose size={18} /></button>
            ) : null}</div>
          </>
        )}
      </header>

      {compact ? (
        <>
          <nav className="sidebar-rail-primary" aria-label={t("WorkspaceSidebar.main_actions")}>
            <button className="sidebar-rail-button" aria-label={t("WorkspaceSidebar.search_conversations")} title={t("WorkspaceSidebar.search_conversations")} onClick={() => setSearchOpen(true)}><Search size={18} /></button>
            <button className="sidebar-rail-button primary" onClick={() => { navigate(routes.chat()); onClose?.(); }} aria-label={t("WorkspaceSidebar.new_conversation")} title={t("WorkspaceSidebar.new_conversation")}>
              <SquarePen size={18} />
            </button>
            <SidebarLink active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={18} />} label={t("WorkspaceSidebar.chat")} compact />
            <SidebarLink active={route.name === "agents"} href={routes.agents()} icon={<Bot size={18} />} label="Agent" compact />
          </nav>
          <div className="sidebar-rail-spacer" />
          <div className="sidebar-rail-utilities">
            <SidebarLink active={route.name === "settings"} href={routes.settings()} icon={<Settings size={18} />} label={t("WorkspaceSidebar.settings")} compact />
            {pwa.installAvailable ? (
              <button className="sidebar-rail-button" onClick={onInstall} aria-label={t("WorkspaceSidebar.install_on_this_device")} title={t("WorkspaceSidebar.install_on_this_device")}><Download size={18} /></button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-primary-actions">
            <button className="button primary" onClick={() => { navigate(routes.chat()); onClose?.(); }} aria-label={t("WorkspaceSidebar.new_conversation")} title={t("WorkspaceSidebar.new_conversation")}>
              <Plus size={17} /> {!compact ? <span>{t("WorkspaceSidebar.new_conversation")}</span> : null}
            </button>
          </div>


          <div className="conversation-scroll">
            {compact ? (
              <nav className="compact-conversations" aria-label={t("WorkspaceSidebar.recent_conversations")}>
                {visible.slice(0, 8).map((conversation) => (
                  <a
                    key={conversation.id}
                    href={routes.chat(conversation.activeBranchId ?? conversation.id)}
                    onClick={linkClick(routes.chat(conversation.activeBranchId ?? conversation.id))}
                    className={conversation.id === activeId ? "active" : ""}
                    title={conversation.title}
                    aria-label={conversation.title}
                  >
                    <MessageSquare size={17} />
                  </a>
                ))}
              </nav>
            ) : groups.length ? groups.map((group) => (
              <section className="conversation-group" key={group.label}>
                <h2>{group.label}</h2>
                <div role="list" aria-label={t("WorkspaceSidebar.conversations", { count: Number((group.label)), value1: (group.label) })}>
                  {group.items.map((conversation) => (
                    <div className="conversation-row" data-active={conversation.id === activeId || undefined} key={conversation.id} role="listitem">
                      <a
                        href={routes.chat(conversation.activeBranchId ?? conversation.id)}
                        onClick={linkClick(routes.chat(conversation.activeBranchId ?? conversation.id))}
                      >
                        <span>{conversation.title || t("WorkspaceSidebar.untitled_conversation")}</span>
                        <small>{offline && !cachedIds.includes(conversation.activeBranchId ?? conversation.id) ? t("WorkspaceSidebar.not_downloaded") : formatTime(conversation.updatedAt)}</small>
                      </a>
                      <div className="conversation-actions">
                        <ConversationPopover><Popover.Trigger asChild><button className="icon-button" aria-label={t("WorkspaceSidebar.conversation_actions", { value1: (conversation.title) })}><MoreHorizontal size={16} /></button></Popover.Trigger>
                          <Popover.Portal><Popover.Content className="composer-more-popover conversation-menu" side="bottom" align="end" sideOffset={4}>
                            <Popover.Close asChild><button disabled={offline} aria-label={t("WorkspaceSidebar.rename", { value1: (conversation.title) })} onClick={() => { setRenaming(conversation); setRenameValue(conversation.title); }}><Pencil size={14} />{t("WorkspaceSidebar.edit_title")}</button></Popover.Close>
                            <Popover.Close asChild><button disabled={offline} className="danger-quiet" aria-label={t("WorkspaceSidebar.delete", { value1: (conversation.title) })} onClick={() => setDeleting(conversation)}><Trash2 size={14} />{t("WorkspaceSidebar.delete_conversation")}</button></Popover.Close>
                          </Popover.Content></Popover.Portal>
                        </ConversationPopover>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )) : (
              <p className="sidebar-empty">{conversations.length ? t("WorkspaceSidebar.no_matching_conversations") : t("WorkspaceSidebar.no_conversations_yet")}</p>
            )}
          </div>

          <nav className="sidebar-navigation" aria-label={t("WorkspaceSidebar.feature_navigation")}>
            <SidebarLink active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={17} />} label={t("WorkspaceSidebar.chat")} compact={compact} />
            <SidebarLink active={route.name === "agents"} href={routes.agents()} icon={<Bot size={17} />} label="Agent" compact={compact} />
            <SidebarLink active={route.name === "settings"} href={routes.settings()} icon={<Settings size={17} />} label={t("WorkspaceSidebar.settings")} compact={compact} />
          </nav>

          {pwa.installAvailable ? <footer className="sidebar-status">
            {pwa.installAvailable ? (
              <button className="icon-button" onClick={onInstall} aria-label={t("WorkspaceSidebar.install_on_this_device")} title={t("WorkspaceSidebar.install_on_this_device")}><Download size={15} /></button>
            ) : null}
          </footer> : null}
        </>
      )}
      {searchOpen ? <ConversationSearch onClose={() => setSearchOpen(false)} /> : null}
      {renaming ? (
        <Modal
          title={t("WorkspaceSidebar.rename_conversation")}
          onClose={() => setRenaming(null)}
          footer={<><button className="button secondary" onClick={() => setRenaming(null)}>{t("WorkspaceSidebar.cancel")}</button><button className="button primary" disabled={busy || !renameValue.trim()} onClick={() => void rename()}>{t("WorkspaceSidebar.save")}</button></>}
        >
          <label className="field"><span>{t("WorkspaceSidebar.conversation_title")}</span><input className="input" aria-label={t("WorkspaceSidebar.conversation_title")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label>
        </Modal>
      ) : null}
      {deleting ? (
        <ConfirmModal title={t("WorkspaceSidebar.delete_conversation")} message={t("WorkspaceSidebar.delete_and_all_its_branches_and_messages_this_cannot_be", { value1: (deleting.title) })} confirmLabel={t("WorkspaceSidebar.delete_2")} danger busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
      ) : null}
    </aside>
  );
}

function SidebarLink({ active, href, icon, label, compact }: { active: boolean; href: string; icon: ReactNode; label: string; compact: boolean }) {
  useLocale();
  return (
    <a className={active ? "active" : ""} href={href} onClick={linkClick(href)} aria-current={active ? "page" : undefined} title={compact ? label : undefined}>
      {icon}<span className={compact ? "sr-only" : undefined}>{label}</span>
    </a>
  );
}

function groupConversations(conversations: ConversationDto[]): Array<{ label: string; items: ConversationDto[] }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - 7);
  const groups = new Map<string, ConversationDto[]>();
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt);
    const label = date >= today ? t("WorkspaceSidebar.today") : date >= yesterday ? t("WorkspaceSidebar.yesterday") : date >= week ? t("WorkspaceSidebar.last_7_days") : t("WorkspaceSidebar.earlier");
    const list = groups.get(label) ?? [];
    list.push(conversation);
    groups.set(label, list);
  }
  return [t("WorkspaceSidebar.today"), t("WorkspaceSidebar.yesterday"), t("WorkspaceSidebar.last_7_days"), t("WorkspaceSidebar.earlier")].flatMap((label) => {
    const items = groups.get(label);
    return items?.length ? [{ label, items }] : [];
  });
}

function ConversationPopover({ children }: { children: ReactNode }) {
  useLocale();
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  return <Popover.Root open={open} onOpenChange={setOpen}>{children}</Popover.Root>;
}
