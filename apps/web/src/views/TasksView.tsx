import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskDto, BackgroundTaskEventDto, CodexEventDto, CodexRuntimeDto, CodexSessionDto, CodexThreadDto } from "@llm-chat/contracts";
import { Bot, Link2, Play, RefreshCw, Send, Square, Unplug, X } from "lucide-react";
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
      <CodexPanel conversationId={conversationId} />
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

function CodexPanel({ conversationId }: { conversationId: string }) {
  const eventsConnected = useStore(appStore, (s) => s.eventsConnectionState === "connected");
  const [runtime, setRuntime] = useState<CodexRuntimeDto | null>(null);
  const [sessions, setSessions] = useState<CodexSessionDto[]>([]);
  const [threads, setThreads] = useState<CodexThreadDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<CodexEventDto[]>([]);
  const [draft, setDraft] = useState("");
  const [threadId, setThreadId] = useState("");
  const [profile, setProfile] = useState<"server-workspace" | "trusted-local-yolo">("server-workspace");
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);

  const load = useCallback(async () => {
    try {
      const [nextRuntime, rawSessions] = await Promise.all([
        endpoints.codexRuntime(), endpoints.codexSessions(conversationId)
      ]);
      const nextSessions = Array.isArray(rawSessions) ? rawSessions : [];
      setRuntime(nextRuntime);
      setSessions(nextSessions);
      setSelectedId((current) => current && nextSessions.some((session) => session.id === current)
        ? current : nextSessions[0]?.id ?? null);
    } catch (cause) {
      toastError(cause);
    }
  }, [conversationId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      const detail = await endpoints.codexSession(selectedId, cursor.current);
      setSessions((current) => current.map((session) => session.id === detail.session.id ? detail.session : session));
      if (detail.events.length) {
        setEvents((current) => [...current, ...detail.events]);
        cursor.current = detail.events[detail.events.length - 1]!.id;
      }
    } catch (cause) {
      toastError(cause);
    }
  }, [selectedId]);

  useEffect(() => {
    setRuntime(null);
    setSessions([]);
    setThreads([]);
    setSelectedId(null);
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [conversationId, load, eventsConnected]);

  useEffect(() => {
    cursor.current = 0;
    setEvents([]);
    void loadDetail();
    const timer = setInterval(() => void loadDetail(), 1_500);
    return () => clearInterval(timer);
  }, [selectedId, loadDetail]);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;
  const create = async (existingThreadId?: string) => {
    setBusy(true);
    try {
      const next = await endpoints.createCodexSession({
        conversationId, profile, ...(existingThreadId ? { threadId: existingThreadId } : {})
      });
      setSessions((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      setSelectedId(next.id);
      setThreadId("");
      toast("success", existingThreadId ? "已接管 Codex 会话" : "已启动 Codex 会话");
    } catch (cause) {
      toastError(cause);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || !draft.trim()) return;
    setBusy(true);
    try {
      await endpoints.sendCodexTurn(selected.id, { text: draft.trim() });
      setDraft("");
      await loadDetail();
    } catch (cause) {
      toastError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card codex-panel" aria-label="Codex 控制面板">
      <div className="task-detail-heading">
        <h3><Bot size={18} />Codex Worker</h3>
        <span className={`tag ${runtime?.connected ? "success" : runtime?.error ? "danger" : "muted"}`}>
          {runtime?.connected ? `已连接${runtime.version ? ` · ${runtime.version}` : ""}` : runtime?.error ? "不可用" : "检查中"}
        </span>
        <button className="btn ghost small" onClick={() => void load()} title="刷新 Codex 状态"><RefreshCw size={14} />刷新</button>
      </div>
      <div className="codex-panel-toolbar">
        <select className="select" aria-label="Codex 运行策略" value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)}>
          <option value="server-workspace">服务器工作区</option>
          <option value="trusted-local-yolo">本机 YOLO</option>
        </select>
        <input className="input mono" aria-label="已有 Codex thread ID" placeholder="已有 thread ID（可选）" value={threadId} onChange={(event) => setThreadId(event.target.value)} />
        <button className="btn small" disabled={busy || !runtime?.available} onClick={() => void create(threadId.trim() || undefined)}>
          {threadId.trim() ? <Link2 size={14} /> : <Play size={14} />}{threadId.trim() ? "接管" : "启动"}
        </button>
        <button className="btn ghost small" disabled={busy || !runtime?.connected} onClick={() => {
          endpoints.codexThreads(selected?.cwd).then(setThreads).catch(toastError);
        }}><RefreshCw size={14} />发现已有</button>
      </div>
      {threads.length ? (
        <div className="codex-thread-list" aria-label="可接管的 Codex 会话">
          {threads.map((thread) => (
            <button key={thread.id} className="btn ghost small mono" onClick={() => setThreadId(thread.id)} title={thread.preview || thread.id}>
              <Link2 size={13} />{thread.name || thread.preview || thread.id.slice(0, 12)}
            </button>
          ))}
        </div>
      ) : null}
      {sessions.length ? (
        <div className="codex-session-tabs" role="tablist" aria-label="Codex 会话">
          {sessions.map((session) => (
            <button key={session.id} className={`btn small ${session.id === selectedId ? "primary" : "ghost"}`} onClick={() => setSelectedId(session.id)}>
              <span className="mono">{session.preview || session.threadId.slice(0, 12)}</span><StatusTag status={session.status} />
            </button>
          ))}
        </div>
      ) : <p className="small muted">还没有绑定的 Codex 会话。可以启动新会话，或发现并接管已有 thread。</p>}
      {selected ? (
        <>
          <div className="small muted codex-session-meta">
            <span className="mono">{selected.cwd}</span> · {selected.profile} · thread <span className="mono">{selected.threadId}</span>
            <button className="btn ghost small" onClick={() => {
              endpoints.interruptCodex(selected.id).then(() => void load()).catch(toastError);
            }}><Square size={13} />中断</button>
            <button className="btn ghost small" onClick={() => {
              endpoints.detachCodex(selected.id).then(() => { setSelectedId(null); void load(); }).catch(toastError);
            }}><Unplug size={13} />解绑</button>
          </div>
          <div className="codex-events" aria-label="Codex 事件">
            {events.length ? events.slice(-80).map((event) => (
              <div className="codex-event" key={event.id}>
                <span className="tag muted">{event.kind}</span>
                <span className="mono small">{codexEventText(event)}</span>
                {event.kind === "approval" ? (
                  <div className="row compact">
                    <button className="btn small" onClick={() => {
                      endpoints.respondCodex(selected.id, { requestId: String(event.payload.requestId ?? ""), response: { decision: "accept" } }).then(() => void loadDetail()).catch(toastError);
                    }}>允许</button>
                    <button className="btn small danger" onClick={() => {
                      endpoints.respondCodex(selected.id, { requestId: String(event.payload.requestId ?? ""), response: { decision: "decline" } }).then(() => void loadDetail()).catch(toastError);
                    }}>拒绝</button>
                  </div>
                ) : null}
              </div>
            )) : <span className="small muted">等待 Codex 事件…</span>}
          </div>
          <div className="codex-composer">
            <textarea className="textarea" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="给 Codex 发送编码任务…" />
            <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void send()}><Send size={15} />发送</button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function codexEventText(event: CodexEventDto): string {
  const payload = event.payload;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.status === "string") return `${event.method}: ${payload.status}`;
  return `${event.method} ${JSON.stringify(payload).slice(0, 500)}`;
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
