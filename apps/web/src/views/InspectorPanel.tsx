import { t, useLocale } from "../lib/i18n";
import { ToolCallContent } from "../components/chat/ToolPresentation";
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
  useLocale();
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
    <aside className="inspector-panel" aria-label={t("InspectorPanel.inspector")}>
      <header className="inspector-header">
        <div>
          <strong>{tool ? tool.name : generation ? t("TrajectoryView.generation_v", { value1: (generation.version) }) : task ? t("TrajectoryView.background_tasks") : t("InspectorPanel.conversation_inspector")}</strong>
          <span>{target ? inspectionSubtitle(target) : t("InspectorPanel.effective_configuration_and_runtime_status")}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t("App.close_inspector")} title={t("App.close_inspector")}><X size={17} /></button>
      </header>
      <div className="inspector-scroll">
        {!conversation ? <EmptyState title={t("InspectorPanel.select_a_conversation_to_view_details")} /> : null}
        {conversation && !target ? (
          <>
            <InspectorSection title="Agent" icon={<Bot size={15} />}>
              <Definition label={t("SettingsView.name")} value={agent?.name ?? t("InspectorPanel.agent_deleted")} />
              <Definition label={t("SettingsView.revision")} value={agent ? `v${agent.revision}` : "—"} />
            </InspectorSection>
            <InspectorSection title={t("InspectorPanel.current_execution")} icon={<Settings2 size={15} />}>
              <Definition label={t("InspectorPanel.model")} value={model?.displayName ?? t("InspectorPanel.no_model_selected")} />
              <Definition label={t("InspectorPanel.context")} value={conversation.contextPolicy} />
              <Definition label={t("SettingsView.working_directory")} value={conversation.workspacePath ?? t("InspectorPanel.not_assigned")} mono />
              <Definition label={t("InspectorPanel.overrides")} value={Object.keys(conversation.executionOverrides).length.toString()} />
            </InspectorSection>
            {conversation.forkedFrom ? (
              <InspectorSection title={t("InspectorPanel.branch_origin")} icon={<GitFork size={15} />}>
                <Definition label={t("InspectorPanel.source_conversation")} value={
                  <button className="link-button" onClick={() => navigate(routes.chat(conversation.forkedFrom!.conversationId))}>{t("InspectorPanel.open")}</button>
                } />
                <Definition label={t("InspectorPanel.source_message")} value={conversation.forkedFrom.messageId ?? t("InspectorPanel.start_of_conversation")} mono />
              </InspectorSection>
            ) : null}
            {contextSummary ? (
              <InspectorSection title={t("InspectorPanel.compaction_checkpoint")} icon={<Minimize2 size={15} />}>
                <Definition label={t("InspectorPanel.covers_through")} value={t("InspectorPanel.message", { value1: (contextSummary.throughOrdinal) })} />
                <Definition label={t("InspectorPanel.model")} value={contextSummary.modelKey} mono />
                <Definition label={t("InspectorPanel.summary_usage")} value={`${formatTokens(contextSummary.usage.totalTokens)} tokens`} />
                <Definition label={t("InspectorPanel.created_at")} value={formatTime(contextSummary.createdAt)} />
              </InspectorSection>
            ) : null}
            {Object.keys(conversation.executionOverrides).length > 0 ? (
              <JsonSection title={t("InspectorPanel.conversation_overrides")} value={conversation.executionOverrides} />
            ) : null}
          </>
        ) : null}
        {generation && !tool ? (
          <>
            <InspectorSection title={t("InspectorPanel.generation_snapshot")} icon={<Gauge size={15} />}>
              <Definition label="Agent" value={generation.generatedAgent?.name ?? "—"} />
              <Definition label={t("InspectorPanel.agent_revision")} value={generation.generatedAgent ? `v${generation.generatedAgent.revision}` : "—"} />
              <Definition label={t("InspectorPanel.total_usage")} value={`${formatTokens(generation.usage.totalTokens)} tokens`} />
              <Definition label={t("InspectorPanel.duration")} value={generation.completedAt ? `${Math.max(0, generation.completedAt - generation.createdAt)} ms` : "—"} />
              <Definition label={t("TasksView.status")} value={<StatusTag status={generation.status} />} />
              <Definition label={t("InspectorPanel.model")} value={`${generation.connectionName} / ${generation.modelKey}`} />
              <Definition label={t("InspectorPanel.protocol")} value={generation.protocol} mono />
              <Definition label={t("TasksView.start")} value={formatTime(generation.createdAt)} />
              <Definition label={t("InspectorPanel.completed")} value={generation.completedAt ? formatTime(generation.completedAt) : "—"} />
              <Definition label={t("InspectorPanel.input")} value={`${formatTokens(generation.usage.inputTokens)} tokens`} />
              <Definition label={t("InspectorPanel.output")} value={`${formatTokens(generation.usage.outputTokens)} tokens`} />
              <Definition label={t("TrajectoryView.reasoning")} value={`${formatTokens(generation.usage.reasoningTokens)} tokens`} />
              <Definition label={t("InspectorPanel.cache")} value={formatCachedTokens(generation.usage.cachedInputTokens, generation.usage.inputTokens)} />
            </InspectorSection>
            {generation.context ? <JsonSection title={t("InspectorPanel.context_decision")} value={generation.context} /> : null}
            {generation.visionAnalyses.length ? <JsonSection title={t("InspectorPanel.image_preprocessing")} value={generation.visionAnalyses} /> : null}
            <JsonSection title={t("InspectorPanel.effective_settings")} value={generation.settings} />
            {generation.error ? <JsonSection title={t("SettingsView.error")} value={generation.error} /> : null}
          </>
        ) : null}
        {tool ? (
          <>
            <InspectorSection title={t("InspectorPanel.tool_call")} icon={<Wrench size={15} />}>
              <Definition label={t("SettingsView.name")} value={tool.name} mono />
              <Definition label={t("TasksView.status")} value={<StatusTag status={tool.approvalState} />} />
              <Definition label={t("InspectorPanel.approval_required")} value={tool.requiresApproval ? t("InspectorPanel.yes") : t("InspectorPanel.no")} />
              <Definition label={t("TasksView.start")} value={tool.startedAt ? formatTime(tool.startedAt) : "—"} />
              <Definition label={t("InspectorPanel.completed")} value={tool.completedAt ? formatTime(tool.completedAt) : "—"} />
            </InspectorSection>
            <ToolCallContent key={tool.id} call={tool} />
            {tool.artifacts.length ? <JsonSection title={t("InspectorPanel.image_artifacts")} value={tool.artifacts} /> : null}
          </>
        ) : null}
        {target?.kind === "task" && !task ? <div className="loading-box">{t("InspectorPanel.loading_task")}</div> : null}
        {task ? (
          <>
            <InspectorSection title={t("TrajectoryView.background_tasks")} icon={<TerminalSquare size={15} />}>
              <Definition label={t("TasksView.status")} value={<StatusTag status={task.task.status} />} />
              <Definition label={t("TasksView.mode")} value={task.task.mode} mono />
              <Definition label="Agent" value={task.task.agentName} />
              <Definition label={t("InspectorPanel.directory")} value={task.task.workspacePath} mono />
              <Definition label={t("TasksView.exit_code")} value={task.task.exitCode?.toString() ?? "—"} />
            </InspectorSection>
            <CodeSection title={t("TasksView.command")} value={task.task.command} />
            <TaskEvents events={task.events} />
            <button className="button secondary full" onClick={() => navigate(routes.conversationTasks(task.task.conversationId, task.task.id))}>
              <ExternalLink size={15} />{t("InspectorPanel.open_in_conversation_tasks")}</button>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function inspectionSubtitle(target: InspectionTarget): string {
  if (target.kind === "tool") return t("InspectorPanel.tool_arguments_and_results");
  if (target.kind === "task") return t("InspectorPanel.task_status_and_events");
  return t("InspectorPanel.model_usage_and_context");
}

function InspectorSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  useLocale();
  return <section className="inspector-section"><h3>{icon}{title}</h3><dl>{children}</dl></section>;
}

function Definition({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  useLocale();
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>;
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  useLocale();
  return <CodeSection title={title} value={JSON.stringify(value, null, 2)} />;
}

function CodeSection({ title, value, danger }: { title: string; value: string; danger?: boolean }) {
  useLocale();
  return <section className="inspector-code"><h3>{title}</h3><pre data-danger={danger || undefined}>{value}</pre></section>;
}

function TaskEvents({ events }: { events: BackgroundTaskEventDto[] }) {
  useLocale();
  if (!events.length) return null;
  return <section className="inspector-section"><h3>{t("TasksView.events")}</h3><ol className="event-list">{events.map((event) => <li key={event.id}><time>{formatTime(event.createdAt)}</time><span>{event.type}</span><small>{event.reason ?? ""}</small></li>)}</ol></section>;
}
