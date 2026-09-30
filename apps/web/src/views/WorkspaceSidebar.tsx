import { PopoverLayer, Presence } from "../lib/motion";
import { t, useLocale, localized } from "../lib/i18n";
import { conversationDeleted } from "../lib/conversation-lifecycle";
import { offlineStore } from "../lib/offline-history";
import { useMemo, useState, type ReactNode } from "react";
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
import { appStore, refreshConversations, toast, toastError, updateConversationImmediately } from "../lib/app-state";
import { conversationEntryTarget, listConversationFamilies, resolveConversationRoot } from "../lib/conversation-tree";
import { formatTime } from "../lib/format";
import { linkClick, navigate, routes, type Route } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, Modal } from "../lib/ui";
import { Popover } from "radix-ui";
import { ConversationSearch } from "../components/ConversationSearch";
import { ConversationList } from "../components/ConversationList";
import type { PwaState } from "../lib/pwa";

export function WorkspaceSidebar({
  route,
  compact,
  onClose,
  onNavigate,
  onToggleCompact,
  pwa,
  onInstall
}: {
  route: Route;
  compact: boolean;
  onClose?: () => void;
  onNavigate?: (path: string) => void;
  onToggleCompact?: () => void;
  pwa: PwaState;
  onInstall: () => void;
}) {
  useLocale();
  const open = (path: string) => {
    if (onNavigate) onNavigate(path);
    else { navigate(path); onClose?.(); }
  };
  const offline = useStore(offlineStore, (state) => state.offline);
  const cachedIds = useStore(offlineStore, (state) => state.cachedIds);
  const conversations = useStore(appStore, (state) => state.conversations);
  const [searchOpen, setSearchOpen] = useState(false);
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
      activeBranchId: conversationEntryTarget(family.root, conversations),
      updatedAt: family.latestUpdatedAt
    })), [families]);
  const groups = useMemo(() => groupConversations(visible), [visible]);

  const rename = async () => {
    if (!renaming || !renameValue.trim()) return;
    const target = renaming;
    setBusy(true);
    setRenaming(null);
    try {
      await updateConversationImmediately(target.id, { title: renameValue.trim() });
      void refreshConversations().catch(toastError);
      toast("success", localized("WorkspaceSidebar.conversation_renamed"));
    } catch (error) {
      setRenaming(current => current ?? target);
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
      void refreshConversations().catch(toastError);
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
    <aside className="workspace-sidebar" data-compact={compact || undefined} aria-label={t("WorkspaceSidebar.main_navigation_and_conversations")}>
      <header className="sidebar-brand">
        {compact ? (
          <button className="sidebar-brand-button" onClick={onToggleCompact} aria-label={t("WorkspaceSidebar.expand_conversation_sidebar")} title={t("WorkspaceSidebar.expand_conversation_sidebar")}>
            <img src="/icons/icon-192-v2.png" width={28} height={28} alt="" />
            <PanelLeftOpen className="sidebar-brand-action" size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            <a href="/" onClick={linkClick("/", open)} aria-label={t("WorkspaceSidebar.chat_home")}>
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
            <button className="sidebar-rail-button primary" onClick={() => open(routes.chat())} aria-label={t("WorkspaceSidebar.new_conversation")} title={t("WorkspaceSidebar.new_conversation")}>
              <SquarePen size={18} />
            </button>
            <SidebarLink onNavigate={open} active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={18} />} label={t("WorkspaceSidebar.chat")} compact />
            <SidebarLink onNavigate={open} active={route.name === "agents"} href={routes.agents()} icon={<Bot size={18} />} label="Agent" compact />
          </nav>
          <div className="sidebar-rail-spacer" />
          <div className="sidebar-rail-utilities">
            <SidebarLink onNavigate={open} active={route.name === "settings"} href={routes.settings()} icon={<Settings size={18} />} label={t("WorkspaceSidebar.settings")} compact />
            {pwa.installAvailable ? (
              <button className="sidebar-rail-button" onClick={onInstall} aria-label={t("WorkspaceSidebar.install_on_this_device")} title={t("WorkspaceSidebar.install_on_this_device")}><Download size={18} /></button>
            ) : null}
          </div>
        </>
      ) : null}
        <div className="sidebar-expanded" hidden={compact} inert={compact || undefined} aria-hidden={compact || undefined}>
          <div className="sidebar-primary-actions">
            <button className="button primary" onClick={() => open(routes.chat())} aria-label={t("WorkspaceSidebar.new_conversation")} title={t("WorkspaceSidebar.new_conversation")}>
              <Plus size={17} /> {!compact ? <span>{t("WorkspaceSidebar.new_conversation")}</span> : null}
            </button>
          </div>


          {groups.length ? <ConversationList groups={groups} activeId={activeId} renderRow={conversation => (
                    <div className="conversation-row" data-active={conversation.id === activeId || undefined} key={conversation.id} role="listitem">
                      <a
                        href={routes.chat(conversation.activeBranchId ?? conversation.id)}
                        onClick={linkClick(routes.chat(conversation.activeBranchId ?? conversation.id), open)}
                      >
                        <span>{conversation.title || t("WorkspaceSidebar.untitled_conversation")}</span>
                        <small>{offline && !cachedIds.includes(conversation.activeBranchId ?? conversation.id) ? t("WorkspaceSidebar.not_downloaded") : formatTime(conversation.updatedAt)}</small>
                      </a>
                      <div className="conversation-actions">
                        <ConversationPopover>{(open, close) => <><Popover.Trigger asChild><button className="icon-button" aria-label={t("WorkspaceSidebar.conversation_actions", { value1: (conversation.title) })}><MoreHorizontal size={16} /></button></Popover.Trigger>
                          <Popover.Portal><Popover.Content className="composer-more-popover conversation-menu" side="bottom" align="end" sideOffset={4} inert={!open ? true : undefined} aria-hidden={!open || undefined}><PopoverLayer open={open} onClose={close} />
                            <Popover.Close asChild><button aria-label={t("WorkspaceSidebar.rename", { value1: (conversation.title) })} onClick={() => { setRenaming(conversation); setRenameValue(conversation.title); }}><Pencil size={14} />{t("WorkspaceSidebar.edit_title")}</button></Popover.Close>
                            <Popover.Close asChild><button className="danger-quiet" aria-label={t("WorkspaceSidebar.delete", { value1: (conversation.title) })} onClick={() => setDeleting(conversation)}><Trash2 size={14} />{t("WorkspaceSidebar.delete_conversation")}</button></Popover.Close>
                          </Popover.Content></Popover.Portal>
                        </>}</ConversationPopover>
                      </div>
                    </div>
          )} /> : (
              <p className="sidebar-empty">{conversations.length ? t("WorkspaceSidebar.no_matching_conversations") : t("WorkspaceSidebar.no_conversations_yet")}</p>
          )}

          <nav className="sidebar-navigation" aria-label={t("WorkspaceSidebar.feature_navigation")}>
            <SidebarLink onNavigate={open} active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={17} />} label={t("WorkspaceSidebar.chat")} compact={compact} />
            <SidebarLink onNavigate={open} active={route.name === "agents"} href={routes.agents()} icon={<Bot size={17} />} label="Agent" compact={compact} />
            <SidebarLink onNavigate={open} active={route.name === "settings"} href={routes.settings()} icon={<Settings size={17} />} label={t("WorkspaceSidebar.settings")} compact={compact} />
          </nav>

          {pwa.installAvailable ? <footer className="sidebar-status">
            {pwa.installAvailable ? (
              <button className="icon-button" onClick={onInstall} aria-label={t("WorkspaceSidebar.install_on_this_device")} title={t("WorkspaceSidebar.install_on_this_device")}><Download size={15} /></button>
            ) : null}
          </footer> : null}
        </div>
      <Presence>{searchOpen ? <ConversationSearch onClose={() => setSearchOpen(false)} onNavigate={open} /> : null}</Presence>
      <Presence>{renaming ? (
        <Modal
          title={t("WorkspaceSidebar.rename_conversation")}
          onClose={() => setRenaming(null)}
          footer={<><button className="button secondary" onClick={() => setRenaming(null)}>{t("WorkspaceSidebar.cancel")}</button><button className="button primary" disabled={busy || !renameValue.trim()} onClick={() => void rename()}>{t("WorkspaceSidebar.save")}</button></>}
        >
          <label className="field"><span>{t("WorkspaceSidebar.conversation_title")}</span><input className="input" aria-label={t("WorkspaceSidebar.conversation_title")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label>
        </Modal>
      ) : null}</Presence>
      <Presence>{deleting ? (
        <ConfirmModal title={t("WorkspaceSidebar.delete_conversation")} message={t("WorkspaceSidebar.delete_and_all_its_branches_and_messages_this_cannot_be", { value1: (deleting.title) })} confirmLabel={t("WorkspaceSidebar.delete_2")} danger busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
      ) : null}</Presence>
    </aside>
  );
}

function SidebarLink({ active, href, icon, label, compact, onNavigate }: { active: boolean; href: string; icon: ReactNode; label: string; compact: boolean; onNavigate: (path: string) => void }) {
  useLocale();
  return (
    <a className={active ? "active" : ""} href={href} onClick={linkClick(href, onNavigate)} aria-current={active ? "page" : undefined} title={compact ? label : undefined}>
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
  const labels = [t("WorkspaceSidebar.today"), t("WorkspaceSidebar.yesterday"), t("WorkspaceSidebar.last_7_days"), t("WorkspaceSidebar.earlier")] as const;
  const groups = new Map<string, ConversationDto[]>();
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt);
    const label = date >= today ? labels[0] : date >= yesterday ? labels[1] : date >= week ? labels[2] : labels[3];
    const list = groups.get(label) ?? [];
    list.push(conversation);
    groups.set(label, list);
  }
  return labels.flatMap((label) => {
    const items = groups.get(label);
    return items?.length ? [{ label, items }] : [];
  });
}

function ConversationPopover({ children }: { children: (open: boolean, close: () => void) => ReactNode }) {
  useLocale();
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>{children(open, () => setOpen(false))}</Popover.Root>;
}
