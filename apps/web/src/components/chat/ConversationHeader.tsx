import { useEffect, useState } from "react";
import {
  ListTree,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  TerminalSquare
} from "lucide-react";
import type { ConversationDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, refreshConversations, toastError } from "../../lib/app-state";
import { resolveConversationRoot } from "../../lib/conversation-tree";
import { useStore } from "../../lib/store";

export type ConversationView = "chat" | "trajectory" | "tasks";

/** The single app bar for a conversation and its temporary projections. */
export function ConversationHeader({
  conversation,
  view,
  mobile,
  sidebarCollapsed,
  inspectorOpen,
  runningTasks,
  onToggleSidebar,
  onToggleInspector,
  onViewChange
}: {
  conversation: ConversationDto | null;
  view: ConversationView;
  mobile: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  runningTasks: number;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onViewChange: (view: ConversationView) => void;
}) {
  const conversations = useStore(appStore, (state) => state.conversations);
  const displayedConversation = conversation ? resolveConversationRoot(conversation, conversations) : null;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(displayedConversation?.title ?? "");

  useEffect(() => {
    setTitle(displayedConversation?.title ?? "");
    setEditing(false);
  }, [displayedConversation?.id, displayedConversation?.title]);

  const saveTitle = async () => {
    if (!displayedConversation || !title.trim()) return;
    try {
      await endpoints.updateConversation(displayedConversation.id, { title: title.trim() });
      await refreshConversations();
      setEditing(false);
    } catch (error) {
      toastError(error);
    }
  };

  const toggleView = (next: Exclude<ConversationView, "chat">) => {
    onViewChange(view === next ? "chat" : next);
  };

  return (
    <header className="conversation-header">
      <button
        type="button"
        className="icon-button shell-control"
        onClick={onToggleSidebar}
        aria-label={mobile ? "打开导航" : sidebarCollapsed ? "展开会话栏" : "折叠会话栏"}
        title={mobile ? "打开导航" : sidebarCollapsed ? "展开会话栏" : "折叠会话栏"}
      >
        {mobile ? <Menu size={20} /> : sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
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
                setTitle(displayedConversation?.title ?? "");
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="conversation-title"
            onDoubleClick={() => displayedConversation && setEditing(true)}
            aria-label={displayedConversation ? `会话标题：${displayedConversation.title}` : "新会话"}
            title={displayedConversation?.title}
          >
            <strong>{displayedConversation?.title || "新会话"}</strong>
          </button>
        )}
      </div>

      {conversation ? (
        <div className="conversation-projections" aria-label="会话覆盖层">
          <button
            type="button"
            className="icon-button"
            aria-pressed={view === "trajectory"}
            onClick={() => toggleView("trajectory")}
            aria-label={view === "trajectory" ? "关闭运行轨迹" : "打开运行轨迹"}
            title={view === "trajectory" ? "关闭运行轨迹" : "运行轨迹"}
          >
            <ListTree size={17} />
          </button>
          <button
            type="button"
            className="icon-button task-projection-button"
            aria-pressed={view === "tasks"}
            onClick={() => toggleView("tasks")}
            aria-label={view === "tasks" ? "关闭后台任务" : `打开后台任务${runningTasks ? `，${runningTasks} 个运行中` : ""}`}
            title={view === "tasks" ? "关闭后台任务" : "后台任务"}
          >
            <TerminalSquare size={17} />
            {runningTasks ? <b>{runningTasks > 99 ? "99+" : runningTasks}</b> : null}
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
