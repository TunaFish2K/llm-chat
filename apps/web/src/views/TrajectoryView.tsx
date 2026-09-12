import { t, useLocale } from "../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import type { BackgroundTaskDto, ConversationDto, GenerationDto, MessageDto } from "@llm-chat/contracts";
import { ChevronDown, ChevronRight, CircleDot, GitFork, Search, TerminalSquare, Wrench } from "lucide-react";
import { endpoints } from "../lib/api";
import { appStore, loadMessages, toastError } from "../lib/app-state";
import type { InspectionTarget } from "../lib/inspection";
import { useStore } from "../lib/store";
import { EmptyState, StatusTag } from "../lib/ui";
import { formatTime, formatTokens } from "../lib/format";

const EMPTY_MESSAGES: MessageDto[] = [];

export function TrajectoryView({
  conversation,
  onInspect,
  onContinue = () => undefined,
  branching = false
}: {
  conversation: ConversationDto;
  onInspect: (target: InspectionTarget) => void;
  onContinue?: (messageId: string) => void;
  branching?: boolean;
}) {
  useLocale();
  const messages = useStore(appStore, (state) => state.messages[conversation.id] ?? EMPTY_MESSAGES);
  const [tasks, setTasks] = useState<BackgroundTaskDto[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadMessages(conversation.id).catch(toastError);
    void endpoints.backgroundTasks(conversation.id).then(setTasks).catch(toastError);
  }, [conversation.id]);

  const turns = useMemo(() => projectTurns(messages, tasks), [messages, tasks]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? turns.filter((turn) => turn.searchText.toLocaleLowerCase().includes(normalized))
    : turns;
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="trajectory-view">
      <div className="trajectory-toolbar" role="toolbar" aria-label={t("TrajectoryView.activity_toolbar")}>
        <label className="search-field compact">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("TrajectoryView.search_activity")}
            placeholder={t("TrajectoryView.search_messages_models_tools_or_tasks")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="muted small">{t("TrajectoryView.turns_background_tasks", { value1: (turns.length), value2: (tasks.length) })}</span>
      </div>
      <div className="trajectory-scroll">
        {filtered.length === 0 ? (
          <EmptyState title={turns.length ? t("TrajectoryView.no_matching_activity") : t("TrajectoryView.no_activity_yet")} />
        ) : filtered.map((turn, index) => {
          const isCollapsed = collapsed.has(turn.id);
          return (
            <section className="trajectory-turn" key={turn.id}>
              <div className="trajectory-turn-heading">
                <button className="trajectory-turn-header" onClick={() => toggle(turn.id)} aria-expanded={!isCollapsed}>
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <strong>{t("TrajectoryView.turn", { value1: (index + 1) })}</strong>
                  <time>{formatTime(turn.createdAt)}</time>
                  <span className="grow" />
                  <span>{t("TrajectoryView.generations", { value1: (turn.generations.length) })}</span>
                </button>
                <button
                  className="icon-button trajectory-fork"
                  onClick={() => onContinue(turn.assistantMessageId)}
                  disabled={branching}
                  aria-label={t("TrajectoryView.continue_from_turn", { value1: (index + 1) })}
                  title={t("TrajectoryView.create_a_branch_from_this_turn")}
                >
                  <GitFork size={14} />
                </button>
              </div>
              {!isCollapsed ? (
                <div className="trajectory-turn-body">
                  <div className="trajectory-node user-node">
                    <CircleDot size={15} aria-hidden="true" />
                    <div><strong>{t("TrajectoryView.user")}</strong><p>{turn.userText}</p></div>
                  </div>
                  {turn.generations.map((generation) => (
                    <GenerationNode
                      key={generation.id}
                      generation={generation}
                      messageId={turn.assistantMessageId}
                      onInspect={onInspect}
                    />
                  ))}
                  {turn.tasks.map((task) => (
                    <button className="trajectory-node task-node" key={task.id} onClick={() => onInspect({ kind: "task", taskId: task.id })}>
                      <TerminalSquare size={15} aria-hidden="true" />
                      <span className="grow"><strong>{t("TrajectoryView.background_tasks")}</strong><code>{task.command}</code></span>
                      <StatusTag status={task.status} />
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GenerationNode({
  generation,
  messageId,
  onInspect
}: {
  generation: GenerationDto;
  messageId: string;
  onInspect: (target: InspectionTarget) => void;
}) {
  useLocale();
  const timeline = [
    ...generation.blocks.map((block) => ({ kind: "block" as const, stepIndex: block.stepIndex, index: block.index, block })),
    ...generation.toolCalls.map((call) => ({ kind: "tool" as const, stepIndex: call.stepIndex, index: call.index, call }))
  ].sort((left, right) => left.stepIndex - right.stepIndex || (left.kind === right.kind ? left.index - right.index : left.kind === "block" ? -1 : 1));
  return (
    <div className="trajectory-generation">
      <button
        className="trajectory-node generation-node"
        onClick={() => onInspect({ kind: "generation", messageId, generationId: generation.id })}
      >
        <CircleDot size={15} aria-hidden="true" />
        <span className="grow">
          <strong>{t("TrajectoryView.generation_v", { value1: (generation.version) })}</strong>
          <small>{generation.connectionName} / {generation.modelKey}</small>
        </span>
        <span className="usage-compact">{formatTokens(generation.usage.totalTokens)} tok</span>
        <StatusTag status={generation.status} />
      </button>
      {timeline.map((item) => item.kind === "block" ? (
        <div className="trajectory-step" key={item.block.id} data-kind={item.block.type}>
          <span>{item.block.type === "reasoning" ? t("TrajectoryView.reasoning") : item.block.type === "text" ? t("TrajectoryView.answer") : item.block.type}</span>
          <p>{item.block.content || t("TrajectoryView.empty")}</p>
        </div>
      ) : (
        <button
          className="trajectory-step tool-step"
          key={item.call.id}
          onClick={() => onInspect({ kind: "tool", messageId, generationId: generation.id, toolCallId: item.call.id })}
        >
          <Wrench size={14} aria-hidden="true" />
          <code>{item.call.name}</code>
          <span className="grow" />
          {item.call.startedAt && item.call.completedAt ? <span>{Math.max(0, item.call.completedAt - item.call.startedAt)} ms</span> : null}
          <StatusTag status={item.call.approvalState} />
        </button>
      ))}
    </div>
  );
}

interface ProjectedTurn {
  id: string;
  createdAt: number;
  userText: string;
  assistantMessageId: string;
  generations: GenerationDto[];
  tasks: BackgroundTaskDto[];
  searchText: string;
}

export function projectTurns(messages: MessageDto[], tasks: BackgroundTaskDto[]): ProjectedTurn[] {
  const turns: ProjectedTurn[] = [];
  let currentUser: MessageDto | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      currentUser = message;
      continue;
    }
    if (!currentUser) continue;
    const linkedTasks = tasks.filter((task) => message.generations.some((generation) => generation.id === task.generationId));
    const searchText = [
      currentUser.text,
      ...message.generations.flatMap((generation) => [
        generation.connectionName,
        generation.modelKey,
        ...generation.blocks.map((block) => block.content),
        ...generation.toolCalls.flatMap((call) => [call.name, call.arguments, call.output, call.error])
      ]),
      ...linkedTasks.map((task) => task.command)
    ].filter(Boolean).join(" ");
    turns.push({
      id: currentUser.id,
      createdAt: currentUser.createdAt,
      userText: currentUser.text ?? "",
      assistantMessageId: message.id,
      generations: message.generations,
      tasks: linkedTasks,
      searchText
    });
    currentUser = null;
  }
  return turns;
}
