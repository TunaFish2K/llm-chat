import { t, useLocale } from "../../lib/i18n";
import { requestMobileBack } from "../../lib/mobile-navigation";
import { useEffect, useState, type RefCallback } from "react";
import {
  ArrowLeft,
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
  onViewChange,
  actionsRef
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
  actionsRef?: RefCallback<HTMLDivElement>;
}) {
  useLocale();
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
      {mobile ? <button
        type="button"
        className="icon-button shell-control"
        onClick={view !== "chat" ? requestMobileBack : onToggleSidebar}
        aria-label={mobile ? view !== "chat" ? t("index.go_back") : t("index.open_navigation") : sidebarCollapsed ? t("WorkspaceSidebar.expand_conversation_sidebar") : t("WorkspaceSidebar.collapse_conversation_sidebar")}
        title={mobile ? view !== "chat" ? t("index.go_back") : t("index.open_navigation") : sidebarCollapsed ? t("WorkspaceSidebar.expand_conversation_sidebar") : t("WorkspaceSidebar.collapse_conversation_sidebar")}
      >
        {mobile ? view !== "chat" ? <ArrowLeft size={20} /> : <Menu size={20} /> : sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button> : null}

      <div className="conversation-heading">
        {editing ? (
          <input
            className="title-input"
            aria-label={t("WorkspaceSidebar.conversation_title")}
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
            aria-label={displayedConversation ? t("ConversationHeader.conversation_title", { value1: (displayedConversation.title) }) : t("WorkspaceSidebar.new_conversation")}
            title={displayedConversation?.title}
          >
            <strong>{displayedConversation?.title || t("WorkspaceSidebar.new_conversation")}</strong>
          </button>
        )}
      </div>

      {conversation ? (
        <div className="conversation-projections" aria-label={t("ConversationHeader.conversation_overrides")}>
          <button
            type="button"
            className="icon-button"
            aria-pressed={view === "trajectory"}
            onClick={() => toggleView("trajectory")}
            aria-label={view === "trajectory" ? t("ConversationHeader.close_run_trace") : t("ConversationHeader.open_run_trace")}
            title={view === "trajectory" ? t("ConversationHeader.close_run_trace") : t("ChatView.activity")}
          >
            <ListTree size={17} />
          </button>
          <button
            type="button"
            className="icon-button task-projection-button"
            aria-pressed={view === "tasks"}
            onClick={() => toggleView("tasks")}
            aria-label={view === "tasks" ? t("ConversationHeader.close_background_tasks") : t("ConversationHeader.open_background_tasks", { value1: (runningTasks ? t("detail.running_count", { value1: (runningTasks) }) : "") })}
            title={view === "tasks" ? t("ConversationHeader.close_background_tasks") : t("TrajectoryView.background_tasks")}
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
        aria-label={inspectorOpen ? t("App.close_inspector") : t("index.open_inspector")}
        title={inspectorOpen ? t("App.close_inspector") : t("index.open_inspector")}
      >
        {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
      <div className="conversation-action-slot" ref={actionsRef} />
    </header>
  );
}
