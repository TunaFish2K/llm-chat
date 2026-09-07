import { useEffect, useState, type ReactNode } from "react";
import type { BackgroundTaskEventDto, ContextSummaryDto, ConversationDto, MessageDto } from "@llm-chat/contracts";
import { Bot, ExternalLink, Gauge, GitFork, Minimize2, Settings2, TerminalSquare, Wrench, X } from "lucide-react";
import { endpoints, type TaskDetailDto } from "../lib/api";
import { appStore, toastError } from "../lib/app-state";
import { formatCachedTokens, formatTime, formatTokens } from "../lib/format";
import type { InspectionTarget } from "../lib/inspection";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { EmptyState, StatusTag } from "../lib/ui";

const EMPTY_MESSAGES: MessageDto[] = [];

export function InspectorPanel({
  conversation,
  target,
  onClose
}: {
  conversation: ConversationDto | null;
  target: InspectionTarget | null;
  onClose: () => void;
}) {
  const agents = useStore(appStore, (state) => state.agents);
  const models = useStore(appStore, (state) => state.models);
  const messages = useStore(appStore, (state) => conversation ? state.messages[conversation.id] ?? EMPTY_MESSAGES : EMPTY_MESSAGES);
  const [task, setTask] = useState<TaskDetailDto | null>(null);
  const [contextSummary, setContextSummary] = useState<ContextSummaryDto | null>(null);

  useEffect(() => {
    setTask(null);
    if (target?.kind === "task") void endpoints.backgroundTask(target.taskId).then(setTask).catch(toastError);
  }, [target]);

  useEffect(() => {
    let active = true;
    const load = () => {
      if (!conversation) {
        setContextSummary(null);
        return;
      }
      void endpoints.contextSummary(conversation.id).then((summary) => {
        if (active) setContextSummary(summary);
      }).catch(toastError);
    };
    load();
    window.addEventListener("llm-chat:context-summary", load);
    return () => {
      active = false;
      window.removeEventListener("llm-chat:context-summary", load);
    };
  }, [conversation?.id]);

  const generation = target && target.kind !== "task"
    ? messages.find((message) => message.id === target.messageId)?.generations.find((item) => item.id === target.generationId)
    : undefined;
  const tool = target?.kind === "tool" ? generation?.toolCalls.find((item) => item.id === target.toolCallId) : undefined;
  const agent = conversation ? agents.find((item) => item.id === conversation.agentId) : undefined;
  const model = conversation ? models.find((item) => item.id === conversation.modelId) : undefined;

  return (
    <aside className="inspector-panel" aria-label="检查器">
      <header className="inspector-header">
        <div>
          <strong>{tool ? tool.name : generation ? `生成 v${generation.version}` : task ? "后台任务" : "会话检查器"}</strong>
          <span>{target ? inspectionSubtitle(target) : "有效配置与运行状态"}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭检查器" title="关闭检查器"><X size={17} /></button>
      </header>
      <div className="inspector-scroll">
        {!conversation ? <EmptyState title="选择一个会话以查看详情" /> : null}
        {conversation && !target ? (
          <>
            <InspectorSection title="Agent" icon={<Bot size={15} />}>
              <Definition label="名称" value={agent?.name ?? "Agent 已删除"} />
              <Definition label="修订" value={agent ? `v${agent.revision}` : "—"} />
            </InspectorSection>
            <InspectorSection title="当前执行" icon={<Settings2 size={15} />}>
              <Definition label="模型" value={model?.displayName ?? "未选择模型"} />
              <Definition label="上下文" value={conversation.contextPolicy} />
              <Definition label="工作目录" value={conversation.workspacePath ?? "未绑定"} mono />
              <Definition label="覆盖项" value={Object.keys(conversation.executionOverrides).length.toString()} />
            </InspectorSection>
            {conversation.forkedFrom ? (
              <InspectorSection title="分支来源" icon={<GitFork size={15} />}>
                <Definition label="来源会话" value={
                  <button className="link-button" onClick={() => navigate(routes.chat(conversation.forkedFrom!.conversationId))}>打开</button>
                } />
                <Definition label="来源消息" value={conversation.forkedFrom.messageId ?? "会话起点"} mono />
              </InspectorSection>
            ) : null}
            {contextSummary ? (
              <InspectorSection title="压缩检查点" icon={<Minimize2 size={15} />}>
                <Definition label="覆盖至" value={`消息 #${contextSummary.throughOrdinal}`} />
                <Definition label="模型" value={contextSummary.modelKey} mono />
                <Definition label="摘要用量" value={`${formatTokens(contextSummary.usage.totalTokens)} tokens`} />
                <Definition label="创建时间" value={formatTime(contextSummary.createdAt)} />
              </InspectorSection>
            ) : null}
            {Object.keys(conversation.executionOverrides).length > 0 ? (
              <JsonSection title="会话覆盖" value={conversation.executionOverrides} />
            ) : null}
          </>
        ) : null}
        {generation && !tool ? (
          <>
            <InspectorSection title="生成快照" icon={<Gauge size={15} />}>
              <Definition label="状态" value={<StatusTag status={generation.status} />} />
              <Definition label="模型" value={`${generation.connectionName} / ${generation.modelKey}`} />
              <Definition label="协议" value={generation.protocol} mono />
              <Definition label="开始" value={formatTime(generation.createdAt)} />
              <Definition label="完成" value={generation.completedAt ? formatTime(generation.completedAt) : "—"} />
              <Definition label="输入" value={`${formatTokens(generation.usage.inputTokens)} tokens`} />
              <Definition label="输出" value={`${formatTokens(generation.usage.outputTokens)} tokens`} />
              <Definition label="推理" value={`${formatTokens(generation.usage.reasoningTokens)} tokens`} />
              <Definition label="缓存" value={formatCachedTokens(generation.usage.cachedInputTokens, generation.usage.inputTokens)} />
            </InspectorSection>
            {generation.context ? <JsonSection title="上下文决策" value={generation.context} /> : null}
            {generation.visionAnalyses.length ? <JsonSection title="识图预处理" value={generation.visionAnalyses} /> : null}
            <JsonSection title="有效设置" value={generation.settings} />
            {generation.error ? <JsonSection title="错误" value={generation.error} /> : null}
          </>
        ) : null}
        {tool ? (
          <>
            <InspectorSection title="工具调用" icon={<Wrench size={15} />}>
              <Definition label="名称" value={tool.name} mono />
              <Definition label="状态" value={<StatusTag status={tool.approvalState} />} />
              <Definition label="需要审批" value={tool.requiresApproval ? "是" : "否"} />
              <Definition label="开始" value={tool.startedAt ? formatTime(tool.startedAt) : "—"} />
              <Definition label="完成" value={tool.completedAt ? formatTime(tool.completedAt) : "—"} />
            </InspectorSection>
            <CodeSection title="参数" value={pretty(tool.arguments)} />
            {tool.output ? <CodeSection title="输出" value={pretty(tool.output)} /> : null}
            {tool.error ? <CodeSection title="错误" value={tool.error} danger /> : null}
            {tool.artifacts.length ? <JsonSection title="图片产物" value={tool.artifacts} /> : null}
          </>
        ) : null}
        {target?.kind === "task" && !task ? <div className="loading-box">正在加载任务…</div> : null}
        {task ? (
          <>
            <InspectorSection title="后台任务" icon={<TerminalSquare size={15} />}>
              <Definition label="状态" value={<StatusTag status={task.task.status} />} />
              <Definition label="模式" value={task.task.mode} mono />
              <Definition label="Agent" value={task.task.agentName} />
              <Definition label="目录" value={task.task.workspacePath} mono />
              <Definition label="退出码" value={task.task.exitCode?.toString() ?? "—"} />
            </InspectorSection>
            <CodeSection title="命令" value={task.task.command} />
            <TaskEvents events={task.events} />
            <button className="button secondary full" onClick={() => navigate(routes.conversationTasks(task.task.conversationId, task.task.id))}>
              <ExternalLink size={15} /> 在会话任务中打开
            </button>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function inspectionSubtitle(target: InspectionTarget): string {
  if (target.kind === "tool") return "工具参数与结果";
  if (target.kind === "task") return "任务状态与事件";
  return "模型、用量与上下文";
}

function InspectorSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="inspector-section"><h3>{icon}{title}</h3><dl>{children}</dl></section>;
}

function Definition({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>;
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  return <CodeSection title={title} value={JSON.stringify(value, null, 2)} />;
}

function CodeSection({ title, value, danger }: { title: string; value: string; danger?: boolean }) {
  return <section className="inspector-code"><h3>{title}</h3><pre data-danger={danger || undefined}>{value}</pre></section>;
}

function TaskEvents({ events }: { events: BackgroundTaskEventDto[] }) {
  if (!events.length) return null;
  return <section className="inspector-section"><h3>事件</h3><ol className="event-list">{events.map((event) => <li key={event.id}><time>{formatTime(event.createdAt)}</time><span>{event.type}</span><small>{event.reason ?? ""}</small></li>)}</ol></section>;
}

function pretty(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
