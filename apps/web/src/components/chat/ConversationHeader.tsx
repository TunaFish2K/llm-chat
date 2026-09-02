import { useEffect, useState } from "react";
import {
  GitFork,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  TerminalSquare,
  Undo2
} from "lucide-react";
import type { ConversationDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, refreshConversations, toastError } from "../../lib/app-state";
import { navigate, routes } from "../../lib/router";
import { useStore } from "../../lib/store";

export type ConversationView = "chat" | "trajectory" | "tasks";

const VIEWS: Array<{ key: ConversationView; label: string; icon: typeof MessageSquare }> = [
  { key: "chat", label: "对话", icon: MessageSquare },
  { key: "trajectory", label: "轨迹", icon: ListTree },
  { key: "tasks", label: "任务", icon: TerminalSquare }
];

/**
 * The conversation's title bar: rename in place, switch between the three
 * conversation views, and reach the two turn-level rewind actions.
 */
export function ConversationHeader({
  conversation,
  view,
  sidebarCollapsed,
  inspectorOpen,
  runningTasks,
  busy,
  compacting,
  canUndo,
  canCompact,
  onToggleSidebar,
  onToggleInspector,
  onViewChange,
  onUndo,
  onCompact
}: {
  conversation: ConversationDto | null;
  view: ConversationView;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  runningTasks: number;
  busy: boolean;
  compacting: boolean;
  canUndo: boolean;
  canCompact: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onViewChange: (view: ConversationView) => void;
  onUndo: () => void;
  onCompact: () => void;
}) {
  const conversations = useStore(appStore, (state) => state.conversations);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation?.title ?? "");
  const parent = conversation?.forkedFrom
    ? conversations.find((item) => item.id === conversation.forkedFrom?.conversationId)
    : undefined;

  useEffect(() => {
    setTitle(conversation?.title ?? "");
    setEditing(false);
  }, [conversation?.id, conversation?.title]);

  const saveTitle = async () => {
    if (!conversation || !title.trim()) return;
    try {
      await endpoints.updateConversation(conversation.id, { title: title.trim() });
      await refreshConversations();
      setEditing(false);
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <header className="conversation-header">
      <button
        type="button"
        className="icon-button shell-control"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "展开会话栏" : "折叠会话栏"}
        title={sidebarCollapsed ? "展开会话栏" : "折叠会话栏"}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>

      <div className="conversation-heading">
        {editing ? (
          <input
            className="title-input"
            aria-label="会话标题"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveTitle();
              if (event.key === "Escape") {
                setTitle(conversation?.title ?? "");
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="conversation-title"
            onDoubleClick={() => conversation && setEditing(true)}
            title={conversation ? "双击重命名" : undefined}
          >
            <strong>{conversation?.title || "新会话"}</strong>
            <span>{conversation ? "后续生成使用会话当前配置" : "首次发送后创建会话"}</span>
          </button>
        )}
        {parent ? (
          <button type="button" className="fork-source" onClick={() => navigate(routes.chat(parent.id))} title="返回来源会话">
            <GitFork size={11} />
            分叉自 {parent.title}
          </button>
        ) : null}
      </div>

      {conversation ? (
        <div className="view-switch" role="tablist" aria-label="会话视图">
          {VIEWS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-label={
                key === "tasks" && runningTasks ? `${label}${runningTasks > 99 ? "99+" : runningTasks}` : label
              }
              aria-selected={view === key}
              onClick={() => onViewChange(key)}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="view-label">{label}</span>
              {key === "tasks" && runningTasks ? <b>{runningTasks > 99 ? "99+" : runningTasks}</b> : null}
            </button>
          ))}
        </div>
      ) : null}

      {conversation ? (
        <div className="header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={onUndo}
            disabled={busy || !canUndo}
            aria-label="撤销上一轮"
            title="撤销上一轮（只回退会话）"
          >
            <Undo2 size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onCompact}
            disabled={busy || !canCompact}
            aria-label="立即压缩上下文"
            title={canCompact ? "立即压缩上下文" : "智能或摘要策略下，至少三轮对话后可压缩"}
          >
            {compacting ? <LoaderCircle className="spin" size={17} /> : <Minimize2 size={17} />}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="icon-button shell-control"
        onClick={onToggleInspector}
        disabled={!conversation}
        aria-label={inspectorOpen ? "关闭检查器" : "打开检查器"}
        title={inspectorOpen ? "关闭检查器" : "打开检查器"}
      >
        {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
    </header>
  );
}
