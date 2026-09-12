import { useErrorState, displayError } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskDto, BackgroundTaskEventDto } from "@llm-chat/contracts";
import { RefreshCw, Square, X } from "lucide-react";
import { endpoints } from "../lib/api";
import { appStore, toast, toastError } from "../lib/app-state";
import { formatBytes, formatTime } from "../lib/format";
import { navigate, replaceRoute, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, ErrorState, LoadingState, StatusTag } from "../lib/ui";

export function ConversationTasksView({ conversationId, taskId }: { conversationId: string; taskId: string | null }) {
  useLocale();
  const eventsConnected = useStore(appStore, (s) => s.eventsConnectionState === "connected");
  const runningTasks = useStore(appStore, (s) => s.runningTasksByConversation[conversationId] ?? 0);
  const [tasks, setTasks] = useState<BackgroundTaskDto[] | null>(null);
  const [error, setError] = useErrorState(null);
  const [stopping, setStopping] = useState<BackgroundTaskDto | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks(await endpoints.backgroundTasks(conversationId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("TasksView.could_not_load_background_tasks"));
    }
  }, [conversationId]);

  useEffect(() => setTasks(null), [conversationId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load, eventsConnected, runningTasks]);

  return (
    <div className="conversation-tasks-view">
      <div className="conversation-tasks-toolbar" role="toolbar" aria-label={t("TasksView.background_task_toolbar")}>
        <span className="small muted">
          {tasks ? t("TasksView.tasks", { value1: (tasks.length), value2: (runningTasks ? t("detail.running", { value1: (runningTasks) }) : "") }) : t("TasksView.loading_tasks")}
        </span>
        <button className="button secondary small" onClick={() => void load()}>
          <RefreshCw size={14} />{t("TasksView.refresh")}</button>
      </div>
      <div className="panel-scroll">
        <div className="panel-inner">
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tasks === null ? (
            <LoadingState label={t("TasksView.loading_background_tasks")} />
          ) : tasks.length === 0 ? (
            <EmptyState title={t("TasksView.no_background_tasks")} hint={t("TasksView.background_commands_started_by_the_model_appear_here")} />
          ) : (
            <table className="table conversation-task-table">
              <thead>
                <tr>
                  <th>{t("TasksView.command")}</th>
                  <th>Agent</th>
                  <th>{t("TasksView.status")}</th>
                  <th>{t("TasksView.mode")}</th>
                  <th>{t("TasksView.started_at")}</th>
                  <th>{t("TasksView.exit_code")}</th>
                  <th>{t("TasksView.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} style={task.id === taskId ? { background: "var(--accent-soft)" } : undefined}>
                    <td className="conversation-task-command" data-label={t("TasksView.command")}>
                      <button className="btn ghost small mono" onClick={() => navigate(routes.conversationTasks(conversationId, task.id))}>
                        {task.command.length > 60 ? `${task.command.slice(0, 60)}…` : task.command}
                      </button>
                    </td>
                    <td className="conversation-task-meta" data-label="Agent">{task.agentName}</td>
                    <td className="conversation-task-meta" data-label={t("TasksView.status")}>
                      <StatusTag status={task.status} />
                      {task.overdue ? <span className="tag warn">{t("TasksView.overdue")}</span> : null}
                    </td>
                    <td className="conversation-task-meta" data-label={t("TasksView.mode")}>{task.mode}</td>
                    <td className="conversation-task-meta" data-label={t("TasksView.start")}>{formatTime(task.startedAt)}</td>
                    <td className="conversation-task-meta" data-label={t("TasksView.exit_code")}>{task.exitCode ?? "—"}</td>
                    <td className="conversation-task-actions" data-label={t("TasksView.actions")}>
                      {["queued", "starting", "running"].includes(task.status) ? (
                        <button className="btn small danger" onClick={() => setStopping(task)}>
                          <Square size={13} />{t("TasksView.stop")}</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {taskId ? <TaskDetail conversationId={conversationId} taskId={taskId} /> : null}
        </div>
      </div>
      {stopping ? (
        <StopTaskModal
          task={stopping}
          onClose={() => setStopping(null)}
          onStopped={() => {
            setStopping(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function StopTaskModal({
  task,
  onClose,
  onStopped
}: {
  task: BackgroundTaskDto;
  onClose: () => void;
  onStopped: () => void;
}) {
  useLocale();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmModal
      title={t("TasksView.stop_background_task")}
      message={
        <div>
          <p className="mono small">{task.command}</p>
          <div className="field">
            <label htmlFor="stop-reason">{t("TasksView.reason_for_stopping")}</label>
            <input
              id="stop-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("TasksView.for_example_this_task_is_no_longer_needed")}
            />
          </div>
        </div>
      }
      confirmLabel={t("TasksView.stop_task")}
      danger
      busy={busy}
      confirmDisabled={!reason.trim()}
      onClose={onClose}
      onConfirm={() => {
        setBusy(true);
        endpoints
          .stopBackgroundTask(task.id, reason.trim())
          .then(() => {
            toast("success", localized("TasksView.task_stop_requested"));
            onStopped();
          })
          .catch(toastError)
          .finally(() => setBusy(false));
      }}
    />
  );
}

function TaskDetail({ conversationId, taskId }: { conversationId: string; taskId: string }) {
  useLocale();
  const eventsConnected = useStore(appStore, (s) => s.eventsConnectionState === "connected");
  const [detail, setDetail] = useState<{ task: BackgroundTaskDto; events: BackgroundTaskEventDto[] } | null>(null);
  const [error, setError] = useErrorState(null);
  const [output, setOutput] = useState("");
  const [screen, setScreen] = useState<string | null>(null);
  const cursor = useRef(0);
  const [columns, setColumns] = useState("120");
  const [rows, setRows] = useState("30");
  const terminalRef = useRef<HTMLPreElement>(null);

  const loadDetail = useCallback(async () => {
    try {
      const next = await endpoints.backgroundTask(taskId);
      if (next.task.conversationId !== conversationId) {
        replaceRoute(routes.conversationTasks(next.task.conversationId, next.task.id));
        return;
      }
      setDetail(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("App.could_not_load_the_task"));
    }
  }, [conversationId, taskId]);

  const loadOutput = useCallback(async () => {
    try {
      const chunk = await endpoints.backgroundTaskOutput(taskId, cursor.current);
      if (chunk.gap) {
        setOutput((current) => t("TasksView.n_gap_in_log_continuing_from_the_latest_position_n", { value1: (current) }));
      }
      if (chunk.text) setOutput((current) => current + chunk.text);
      setScreen(chunk.screen);
      cursor.current = chunk.cursor;
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("TasksView.could_not_read_the_log"));
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setOutput("");
    setScreen(null);
    cursor.current = 0;
    void loadDetail();
    void loadOutput();
    const timer = setInterval(() => {
      void loadDetail();
      void loadOutput();
    }, 2_000);
    return () => clearInterval(timer);
  }, [taskId, loadDetail, loadOutput, eventsConnected]);

  useEffect(() => {
    const el = terminalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, screen]);

  if (error && !detail) return <ErrorState message={error} onRetry={() => void loadDetail()} />;
  if (!detail) return <LoadingState label={t("TasksView.loading_task")} />;

  const task = detail.task;
  const running = ["queued", "starting", "running"].includes(task.status);

  return (
    <div className="card" aria-label={t("TasksView.task_details")}>
      <div className="task-detail-heading">
        <h3>
          <span className="mono">{task.command}</span>
          <StatusTag status={task.status} />
        </h3>
        <button
          className="icon-button"
          onClick={() => navigate(routes.conversationTasks(conversationId))}
          aria-label={t("TasksView.close_task_details")}
          title={t("TasksView.close_task_details")}
        ><X size={16} /></button>
      </div>
      <p className="small muted">{t("TasksView.working_directory")}<span className="mono">{task.workspacePath}</span>{t("TasksView.mode_log_cursor", { value1: (task.mode), value2: (task.outputCursor), value3: (" "), value4: (task.hardTimeoutMs ? t("detail.hard_timeout_s", { value1: (Math.round(task.hardTimeoutMs / 1000)) }) : t("detail.no_hard_timeout")) })}</p>
      {task.error ? <p style={{ color: "var(--danger)" }}>{displayError({ message: task.error, ...(task.errorI18n ? { i18n: task.errorI18n } : {}) })}</p> : null}

      {task.mode === "pty" && screen !== null ? (
        <>
          <h4>{t("TasksView.terminal_screen")}</h4>
          <pre className="terminal" ref={terminalRef} aria-label={t("TasksView.terminal_screen")} tabIndex={0}>
            {screen}
          </pre>
        </>
      ) : null}
      <h4>{t("TasksView.log_output", { value1: (formatBytes(output.length)) })}</h4>
      <pre className="terminal" ref={task.mode === "pty" ? undefined : terminalRef} aria-label={t("TasksView.task_log")} tabIndex={0}>
        {output || t("TasksView.no_output_yet")}
      </pre>

      {task.mode === "pty" && running ? (
        <div className="row" style={{ marginTop: 8 }}>
          <label className="small">{t("TasksView.columns", { value1: (" ") })}<input
              className="input"
              type="number"
              style={{ width: 90 }}
              aria-label={t("TasksView.terminal_columns")}
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          </label>
          <label className="small">{t("TasksView.rows", { value1: (" ") })}<input
              className="input"
              type="number"
              style={{ width: 90 }}
              aria-label={t("TasksView.terminal_rows")}
              value={rows}
              onChange={(event) => setRows(event.target.value)}
            />
          </label>
          <button
            className="btn small"
            onClick={() => {
              endpoints
                .resizeBackgroundTask(task.id, Number(columns) || 120, Number(rows) || 30)
                .then(() => toast("success", localized("TasksView.terminal_resized")))
                .catch(toastError);
            }}
          >{t("TasksView.resize_terminal")}</button>
        </div>
      ) : null}

      <h4 style={{ marginTop: 16 }}>{t("TasksView.events")}</h4>
      {detail.events.length === 0 ? (
        <p className="small muted">{t("TasksView.no_events_yet")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("TasksView.time")}</th>
              <th>{t("TasksView.type")}</th>
              <th>{t("TasksView.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.events.map((event) => (
              <tr key={event.id}>
                <td>{formatTime(event.createdAt)}</td>
                <td>{event.type}</td>
                <td>{event.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
