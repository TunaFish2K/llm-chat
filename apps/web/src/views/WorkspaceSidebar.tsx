import { useMemo, useState, type ReactNode } from "react";
import type { ConversationDto } from "@llm-chat/contracts";
import {
  Bot,
  CheckCircle2,
  CircleEllipsis,
  Download,
  MessageSquare,
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
  const conversations = useStore(appStore, (state) => state.conversations);
  const connectionState = useStore(appStore, (state) => state.eventsConnectionState);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<ConversationDto | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ConversationDto | null>(null);
  const [busy, setBusy] = useState(false);
  const activeConversation = route.name === "chat"
    ? conversations.find((item) => item.id === route.conversationId)
    : undefined;
  const activeId = activeConversation ? resolveConversationRoot(activeConversation, conversations).id : null;
  const normalized = query.trim().toLocaleLowerCase();
  const families = useMemo(() => listConversationFamilies(conversations), [conversations]);
  const visible = useMemo(() => families
    .filter((family) => !normalized || family.root.title.toLocaleLowerCase().includes(normalized))
    .map((family) => ({
      ...family.root,
      activeBranchId: family.root.activeBranchId ?? family.root.id,
      updatedAt: family.latestUpdatedAt
    })), [families, normalized]);
  const groups = useMemo(() => groupConversations(visible), [visible]);

  const rename = async () => {
    if (!renaming || !renameValue.trim()) return;
    setBusy(true);
    try {
      await endpoints.updateConversation(renaming.id, { title: renameValue.trim() });
      await refreshConversations();
      setRenaming(null);
      toast("success", "会话已重命名");
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
      await endpoints.deleteConversation(deleting.id);
      await refreshConversations();
      if (deleting.id === activeId) navigate(routes.chat());
      setDeleting(null);
      toast("success", "会话已删除");
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="workspace-sidebar" data-compact={compact || undefined} aria-label="主导航与会话">
      <header className="sidebar-brand">
        {compact ? (
          <button className="sidebar-brand-button" onClick={onToggleCompact} aria-label="展开会话栏" title="展开会话栏">
            <img src="/icons/icon-192-v2.png" width={28} height={28} alt="" />
            <PanelLeftOpen className="sidebar-brand-action" size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            <a href="/" onClick={linkClick("/")} aria-label="Chat 首页">
              <img src="/icons/icon-192-v2.png" width={28} height={28} alt="" />
              <span>Chat</span>
            </a>
            {onClose ? (
              <button className="icon-button" onClick={onClose} aria-label="关闭导航" title="关闭导航"><X size={18} /></button>
            ) : onToggleCompact ? (
              <button className="icon-button sidebar-collapse-button" onClick={onToggleCompact} aria-label="折叠会话栏" title="折叠会话栏"><PanelLeftClose size={18} /></button>
            ) : null}
          </>
        )}
      </header>

      {compact ? (
        <>
          <nav className="sidebar-rail-primary" aria-label="主要操作">
            <button className="sidebar-rail-button primary" onClick={() => navigate(routes.chat())} aria-label="新会话" title="新会话">
              <SquarePen size={18} />
            </button>
            <SidebarLink active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={18} />} label="聊天" compact />
            <SidebarLink active={route.name === "agents"} href={routes.agents()} icon={<Bot size={18} />} label="Agent" compact />
          </nav>
          <div className="sidebar-rail-spacer" />
          <div className="sidebar-rail-utilities">
            <SidebarLink active={route.name === "settings"} href={routes.settings()} icon={<Settings size={18} />} label="设置" compact />
            {pwa.installAvailable ? (
              <button className="sidebar-rail-button" onClick={onInstall} aria-label="安装到设备" title="安装到设备"><Download size={18} /></button>
            ) : null}
            <span
              className="sidebar-rail-status"
              data-state={connectionState}
              title={connectionStateTitle(connectionState)}
              aria-label={connectionStateTitle(connectionState)}
            >
              {connectionState === "connected" ? <CheckCircle2 size={17} /> : <CircleEllipsis size={17} />}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-primary-actions">
            <button className="button primary" onClick={() => navigate(routes.chat())} aria-label="新会话" title="新会话">
              <Plus size={17} /> {!compact ? <span>新会话</span> : null}
            </button>
          </div>

          {!compact ? (
            <label className="search-field sidebar-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索会话"
                placeholder="搜索会话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? <button onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button> : null}
            </label>
          ) : null}

          <div className="conversation-scroll">
            {compact ? (
              <nav className="compact-conversations" aria-label="最近会话">
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
                <div role="list" aria-label={`${group.label}会话`}>
                  {group.items.map((conversation) => (
                    <div className="conversation-row" data-active={conversation.id === activeId || undefined} key={conversation.id} role="listitem">
                      <a
                        href={routes.chat(conversation.activeBranchId ?? conversation.id)}
                        onClick={linkClick(routes.chat(conversation.activeBranchId ?? conversation.id))}
                      >
                        <span>{conversation.title || "未命名会话"}</span>
                        <small>{formatTime(conversation.updatedAt)}</small>
                      </a>
                      <div className="conversation-actions">
                        <button
                          className="icon-button"
                          aria-label={`重命名 ${conversation.title}`}
                          title="重命名"
                          onClick={() => { setRenaming(conversation); setRenameValue(conversation.title); }}
                        ><Pencil size={14} /></button>
                        <button
                          className="icon-button danger-quiet"
                          aria-label={`删除 ${conversation.title}`}
                          title="删除"
                          onClick={() => setDeleting(conversation)}
                        ><Trash2 size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )) : (
              <p className="sidebar-empty">{conversations.length ? "没有匹配的会话" : "还没有会话"}</p>
            )}
          </div>

          <nav className="sidebar-navigation" aria-label="功能导航">
            <SidebarLink active={route.name === "chat"} href={routes.chat()} icon={<MessageSquare size={17} />} label="聊天" compact={compact} />
            <SidebarLink active={route.name === "agents"} href={routes.agents()} icon={<Bot size={17} />} label="Agent" compact={compact} />
            <SidebarLink active={route.name === "settings"} href={routes.settings()} icon={<Settings size={17} />} label="设置" compact={compact} />
          </nav>

          <footer className="sidebar-status">
            <span data-state={connectionState} title={connectionStateTitle(connectionState)}>
              {connectionState === "connected" ? <CheckCircle2 size={15} /> : <CircleEllipsis size={15} />}
              {!compact ? connectionStateLabel(connectionState) : null}
            </span>
            {pwa.installAvailable ? (
              <button className="icon-button" onClick={onInstall} aria-label="安装到设备" title="安装到设备"><Download size={15} /></button>
            ) : null}
          </footer>
        </>
      )}
      {renaming ? (
        <Modal
          title="重命名会话"
          onClose={() => setRenaming(null)}
          footer={<><button className="button secondary" onClick={() => setRenaming(null)}>取消</button><button className="button primary" disabled={busy || !renameValue.trim()} onClick={() => void rename()}>保存</button></>}
        >
          <label className="field"><span>会话标题</span><input className="input" aria-label="会话标题" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} /></label>
        </Modal>
      ) : null}
      {deleting ? (
        <ConfirmModal title="删除会话" message={`删除“${deleting.title}”及其所有分支和消息？此操作无法恢复。`} confirmLabel="删除" danger busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
      ) : null}
    </aside>
  );
}

function connectionStateTitle(state: "connecting" | "connected" | "reconnecting"): string {
  if (state === "connected") return "事件流已连接";
  return state === "reconnecting" ? "事件流断开，正在重连" : "正在连接事件流";
}

function connectionStateLabel(state: "connecting" | "connected" | "reconnecting"): string {
  if (state === "connected") return "已连接";
  return state === "reconnecting" ? "重连中" : "连接中";
}

function SidebarLink({ active, href, icon, label, compact }: { active: boolean; href: string; icon: ReactNode; label: string; compact: boolean }) {
  return (
    <a className={active ? "active" : ""} href={href} onClick={linkClick(href)} aria-current={active ? "page" : undefined} title={compact ? label : undefined}>
      {icon}<span>{compact ? <span className="sr-only">{label}</span> : label}</span>
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
    const label = date >= today ? "今天" : date >= yesterday ? "昨天" : date >= week ? "最近 7 天" : "更早";
    const list = groups.get(label) ?? [];
    list.push(conversation);
    groups.set(label, list);
  }
  return ["今天", "昨天", "最近 7 天", "更早"].flatMap((label) => {
    const items = groups.get(label);
    return items?.length ? [{ label, items }] : [];
  });
}
