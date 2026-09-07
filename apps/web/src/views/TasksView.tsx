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
  const eventsConnected = useStore(appStore, (s) => s.eventsConnectionState === "connected");
  const runningTasks = useStore(appStore, (s) => s.runningTasksByConversation[conversationId] ?? 0);
  const [tasks, setTasks] = useState<BackgroundTaskDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<BackgroundTaskDto | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks(await endpoints.backgroundTasks(conversationId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载后台任务失败");
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
      <div className="conversation-tasks-toolbar" role="toolbar" aria-label="后台任务工具栏">
        <span className="small muted">
          {tasks ? `${tasks.length} 个任务${runningTasks ? ` · ${runningTasks} 个运行中` : ""}` : "正在加载任务"}
        </span>
        <button className="button secondary small" onClick={() => void load()}>
          <RefreshCw size={14} />刷新
        </button>
      </div>
      <div className="panel-scroll">
        <div className="panel-inner">
          {error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tasks === null ? (
            <LoadingState label="加载后台任务…" />
          ) : tasks.length === 0 ? (
            <EmptyState title="没有后台任务" hint="模型在生成中启动的后台命令会出现在这里。" />
          ) : (
            <table className="table conversation-task-table">
              <thead>
                <tr>
                  <th>命令</th>
                  <th>Agent</th>
                  <th>状态</th>
                  <th>模式</th>
                  <th>开始时间</th>
                  <th>退出码</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} style={task.id === taskId ? { background: "var(--accent-soft)" } : undefined}>
                    <td className="conversation-task-command" data-label="命令">
                      <button className="btn ghost small mono" onClick={() => navigate(routes.conversationTasks(conversationId, task.id))}>
                        {task.command.length > 60 ? `${task.command.slice(0, 60)}…` : task.command}
                      </button>
                    </td>
                    <td className="conversation-task-meta" data-label="Agent">{task.agentName}</td>
                    <td className="conversation-task-meta" data-label="状态">
                      <StatusTag status={task.status} />
                      {task.overdue ? <span className="tag warn">逾期</span> : null}
                    </td>
                    <td className="conversation-task-meta" data-label="模式">{task.mode}</td>
                    <td className="conversation-task-meta" data-label="开始">{formatTime(task.startedAt)}</td>
                    <td className="conversation-task-meta" data-label="退出码">{task.exitCode ?? "—"}</td>
                    <td className="conversation-task-actions" data-label="操作">
                      {["queued", "starting", "running"].includes(task.status) ? (
                        <button className="btn small danger" onClick={() => setStopping(task)}>
                          <Square size={13} />停止
                        </button>
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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmModal
      title="停止后台任务"
      message={
        <div>
          <p className="mono small">{task.command}</p>
          <div className="field">
            <label htmlFor="stop-reason">停止原因</label>
            <input
              id="stop-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：不再需要该任务"
            />
          </div>
        </div>
      }
      confirmLabel="停止任务"
      danger
      busy={busy}
      confirmDisabled={!reason.trim()}
      onClose={onClose}
      onConfirm={() => {
        setBusy(true);
        endpoints
          .stopBackgroundTask(task.id, reason.trim())
          .then(() => {
            toast("success", "已请求停止任务");
            onStopped();
          })
          .catch(toastError)
          .finally(() => setBusy(false));
      }}
    />
  );
}

function TaskDetail({ conversationId, taskId }: { conversationId: string; taskId: string }) {
  const eventsConnected = useStore(appStore, (s) => s.eventsConnectionState === "connected");
  const [detail, setDetail] = useState<{ task: BackgroundTaskDto; events: BackgroundTaskEventDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(cause instanceof Error ? cause.message : "任务加载失败");
    }
  }, [conversationId, taskId]);

  const loadOutput = useCallback(async () => {
    try {
      const chunk = await endpoints.backgroundTaskOutput(taskId, cursor.current);
      if (chunk.gap) {
        setOutput((current) => `${current}\n[日志存在缺口，从最新位置继续]\n`);
      }
      if (chunk.text) setOutput((current) => current + chunk.text);
      setScreen(chunk.screen);
      cursor.current = chunk.cursor;
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "日志读取失败");
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
  if (!detail) return <LoadingState label="加载任务…" />;

  const task = detail.task;
  const running = ["queued", "starting", "running"].includes(task.status);

  return (
    <div className="card" aria-label="任务详情">
      <div className="task-detail-heading">
        <h3>
          <span className="mono">{task.command}</span>
          <StatusTag status={task.status} />
        </h3>
        <button
          className="icon-button"
          onClick={() => navigate(routes.conversationTasks(conversationId))}
          aria-label="关闭任务详情"
          title="关闭任务详情"
        ><X size={16} /></button>
      </div>
      <p className="small muted">
        工作目录 <span className="mono">{task.workspacePath}</span> · 模式 {task.mode} · 日志游标 {task.outputCursor} ·{" "}
        {task.hardTimeoutMs ? `硬超时 ${Math.round(task.hardTimeoutMs / 1000)}s` : "无硬超时"}
      </p>
      {task.error ? <p style={{ color: "var(--danger)" }}>{task.error}</p> : null}

      {task.mode === "pty" && screen !== null ? (
        <>
          <h4>终端画面</h4>
          <pre className="terminal" ref={terminalRef} aria-label="终端画面" tabIndex={0}>
            {screen}
          </pre>
        </>
      ) : null}
      <h4>日志输出（{formatBytes(output.length)}）</h4>
      <pre className="terminal" ref={task.mode === "pty" ? undefined : terminalRef} aria-label="任务日志" tabIndex={0}>
        {output || "（暂无输出）"}
      </pre>

      {task.mode === "pty" && running ? (
        <div className="row" style={{ marginTop: 8 }}>
          <label className="small">
            列{" "}
            <input
              className="input"
              type="number"
              style={{ width: 90 }}
              aria-label="终端列数"
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          </label>
          <label className="small">
            行{" "}
            <input
              className="input"
              type="number"
              style={{ width: 90 }}
              aria-label="终端行数"
              value={rows}
              onChange={(event) => setRows(event.target.value)}
            />
          </label>
          <button
            className="btn small"
            onClick={() => {
              endpoints
                .resizeBackgroundTask(task.id, Number(columns) || 120, Number(rows) || 30)
                .then(() => toast("success", "终端尺寸已调整"))
                .catch(toastError);
            }}
          >
            调整终端尺寸
          </button>
        </div>
      ) : null}

      <h4 style={{ marginTop: 16 }}>事件</h4>
      {detail.events.length === 0 ? (
        <p className="small muted">暂无事件。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>原因</th>
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
