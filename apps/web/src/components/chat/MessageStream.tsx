import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  Gauge,
  GitFork,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Settings2,
  Square,
  Wrench
} from "lucide-react";
import type { GenerationDto, MessageDto, ToolCallDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, toastError, trackGeneration } from "../../lib/app-state";
import { formatCachedTokens, formatTime, formatTokens } from "../../lib/format";
import type { InspectionTarget } from "../../lib/inspection";
import { Markdown } from "../../lib/markdown";
import { useStore } from "../../lib/store";
import { StatusTag } from "../ui";
import { AgentAvatar, CodeField, copyText, ImageGallery, MessageAction } from "./atoms";
import { activeGeneration, answerText, buildTimeline, prettyJson } from "./model";

export interface StreamCallbacks {
  onInspect: (target: InspectionTarget) => void;
  onEdit: (message: MessageDto) => void;
  onContinue: (messageId: string) => void;
  onGreetingFork: (message: MessageDto, greetingIndex: number) => void;
  /** True while a fork or a generation is in flight; blocks branching actions. */
  branching: boolean;
}

/** One turn in the transcript. */
export function MessageItem({
  conversationId,
  message,
  callbacks
}: {
  conversationId: string;
  message: MessageDto;
  callbacks: StreamCallbacks;
}) {
  const agents = useStore(appStore, (state) => state.agents);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const generation = message.role === "assistant" ? activeGeneration(message) : null;
  const generatedAgent = message.greeting?.agent ?? generation?.generatedAgent;
  const agent = agents.find((item) => item.id === generatedAgent?.agentId);

  if (message.role === "user") {
    return (
      <article className="msg" data-role="user">
        {attachments.length ? <ImageGallery assets={attachments} /> : null}
        {message.text ? <div className="msg-bubble">{message.text}</div> : null}
        <div className="msg-actions">
          <time>{formatTime(message.createdAt)}</time>
          <MessageAction label="复制消息" onClick={() => void copyText(message.text ?? "")}>
            <Copy size={14} />
          </MessageAction>
          <MessageAction label="编辑并分叉" disabled={callbacks.branching} onClick={() => callbacks.onEdit(message)}>
            <Pencil size={14} />
          </MessageAction>
        </div>
      </article>
    );
  }

  return (
    <article className="msg" data-role="assistant">
      <div className="msg-head">
        <AgentAvatar agent={agent} label={generatedAgent?.name ?? "AI"} />
        <div className="msg-identity">
          <strong>{generatedAgent?.name ?? "助手"}</strong>
          <span>
            {message.greeting
              ? "开场白"
              : message.generatedModel
              ? `${message.generatedModel.connectionName} / ${message.generatedModel.displayName}`
              : "历史回复"}
          </span>
        </div>
        <time>{formatTime(message.createdAt)}</time>
        {generation ? <StatusTag status={generation.status} /> : null}
      </div>
      {generation ? (
        <GenerationTimeline
          conversationId={conversationId}
          message={message}
          generation={generation}
          callbacks={callbacks}
        />
      ) : message.text ? (
        <>
          <Markdown text={message.text} />
          {message.greeting && message.greeting.variants.length > 1 ? (
            <footer className="stream-footer greeting-footer">
              <VersionSwitcher
                label="开场白切换"
                index={message.greeting.activeIndex}
                total={message.greeting.variants.length}
                disabled={callbacks.branching}
                onChange={(index) => callbacks.onGreetingFork(message, index)}
              />
            </footer>
          ) : null}
        </>
      ) : (
        <p className="muted">（无生成内容）</p>
      )}
    </article>
  );
}

/**
 * Reasoning, answers and tool calls in the order the model emitted them, with
 * the per-generation controls underneath.
 */
function GenerationTimeline({
  conversationId,
  message,
  generation,
  callbacks
}: {
  conversationId: string;
  message: MessageDto;
  generation: GenerationDto;
  callbacks: StreamCallbacks;
}) {
  const settings = useStore(appStore, (state) => state.settings);
  const collapsePolicy = settings?.uiPreferences.reasoningCollapsePolicy ?? "collapse-on-answer";
  const hasAnswer = generation.blocks.some((block) => block.type === "text" && block.content.trim());
  const busy = isGenerationActive(generation.status);
  const timeline = buildTimeline(generation);
  const answer = answerText(generation);
  const versionIndex = message.generations.findIndex((item) => item.id === generation.id);

  const retry = async () => {
    try {
      const result = await endpoints.retryGeneration(message.id);
      await loadMessages(conversationId);
      trackGeneration(conversationId, result.assistantMessageId, result.generationId);
    } catch (error) {
      toastError(error);
    }
  };

  const selectVersion = async (id: string) => {
    try {
      await endpoints.selectGeneration(message.id, id);
      await loadMessages(conversationId);
    } catch (error) {
      toastError(error);
    }
  };

  const inspectGeneration = () =>
    callbacks.onInspect({ kind: "generation", messageId: message.id, generationId: generation.id });

  return (
    <div className="stream" data-busy={busy || undefined}>
      {busy && timeline.length === 0 ? (
        <div className="stream-pending" role="status">
          <LoaderCircle className="spin" size={15} />
          <span>{generation.status === "queued" ? "等待模型响应" : "正在生成"}</span>
        </div>
      ) : null}

      {timeline.map((item) => {
        if (item.kind === "tool") {
          return (
            <ToolCallDisclosure
              key={item.call.id}
              call={item.call}
              onInspect={() =>
                callbacks.onInspect({
                  kind: "tool",
                  messageId: message.id,
                  generationId: generation.id,
                  toolCallId: item.call.id
                })
              }
            />
          );
        }
        const { block } = item;
        if (block.type === "reasoning") {
          const open =
            collapsePolicy === "never-auto-collapse" ||
            (collapsePolicy === "collapse-on-answer" && !hasAnswer && !generation.completedAt);
          return (
            <details className="reasoning-block" key={block.id} open={open}>
              <summary>
                <Gauge size={14} aria-hidden="true" />
                {block.complete ? "推理过程" : "正在推理"}
                <span className="grow" />
                <ChevronDown className="chev" size={14} aria-hidden="true" />
              </summary>
              <div>{block.content}</div>
            </details>
          );
        }
        if (block.type === "refusal") {
          return (
            <div className="refusal-block" role="alert" key={block.id}>
              <strong>模型拒绝回答</strong>
              <p>{block.content}</p>
            </div>
          );
        }
        if (block.type === "unsupported") {
          return (
            <div className="unsupported-block" key={block.id}>
              不支持的内容块：{block.content}
            </div>
          );
        }
        return <Markdown key={block.id} text={block.content} streaming={!block.complete} />;
      })}

      {generation.error ? (
        <div className="refusal-block" role="alert">
          <strong>生成失败（{generation.error.code}）</strong>
          <p>{generation.error.message}</p>
        </div>
      ) : null}
      {generation.stopReason && generation.status !== "completed" ? (
        <p className="muted small">停止原因：{generation.stopReason}</p>
      ) : null}

      <footer className="stream-footer">
        <div className="stream-actions">
          {answer ? (
            <MessageAction label="复制回答" onClick={() => void copyText(answer)}>
              <Clipboard size={14} />
            </MessageAction>
          ) : null}
          {busy ? (
            <MessageAction
              label="停止生成"
              danger
              onClick={() => void endpoints.cancelGeneration(generation.id).catch(toastError)}
            >
              <Square size={14} fill="currentColor" />
            </MessageAction>
          ) : (
            <>
              <MessageAction label="重试" onClick={() => void retry()}>
                <RotateCcw size={14} />
              </MessageAction>
              <MessageAction
                label="从此处继续"
                disabled={callbacks.branching}
                onClick={() => callbacks.onContinue(message.id)}
              >
                <GitFork size={14} />
              </MessageAction>
            </>
          )}
          <MessageAction label="检查生成" onClick={inspectGeneration}>
            <Settings2 size={14} />
          </MessageAction>
          {message.generations.length > 1 ? (
            <VersionSwitcher
              label="生成版本切换"
              index={versionIndex}
              total={message.generations.length}
              onChange={(index) => {
                const item = message.generations[index];
                if (item) void selectVersion(item.id);
              }}
            />
          ) : null}
        </div>

        <button type="button" className="usage-summary" onClick={inspectGeneration}>
          {generation.usage.inputTokens !== undefined ? <span>↑ {formatTokens(generation.usage.inputTokens)}</span> : null}
          {generation.usage.outputTokens !== undefined ? <span>↓ {formatTokens(generation.usage.outputTokens)}</span> : null}
          {generation.usage.totalTokens !== undefined ? <span>合计 {formatTokens(generation.usage.totalTokens)}</span> : null}
          {generation.usage.cachedInputTokens !== undefined ? (
            <span>缓存 {formatCachedTokens(generation.usage.cachedInputTokens, generation.usage.inputTokens).replace(" tokens", "")}</span>
          ) : null}
          {generation.completedAt ? <span>{Math.max(0, generation.completedAt - generation.createdAt)} ms</span> : null}
        </button>
      </footer>
    </div>
  );
}

export function VersionSwitcher({
  label,
  index,
  total,
  disabled = false,
  onChange
}: {
  label: string;
  index: number;
  total: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  return (
    <span className="version-switch" aria-label={label}>
      <button
        type="button"
        aria-label={`上一${label.includes("开场白") ? "条开场白" : "版本"}`}
        disabled={disabled || index <= 0}
        onClick={() => onChange(index - 1)}
      >
        <ChevronLeft size={14} />
      </button>
      <span>{index + 1} / {total}</span>
      <button
        type="button"
        aria-label={`下一${label.includes("开场白") ? "条开场白" : "版本"}`}
        disabled={disabled || index >= total - 1}
        onClick={() => onChange(index + 1)}
      >
        <ChevronRight size={14} />
      </button>
    </span>
  );
}

/** Collapsed by default: arguments and output are inspection material, not prose. */
function ToolCallDisclosure({ call, onInspect }: { call: ToolCallDto; onInspect: () => void }) {
  return (
    <details className="tool-call" data-state={call.approvalState}>
      <summary>
        <Wrench size={15} aria-hidden="true" />
        <code>{call.name}</code>
        <span className="grow" />
        {call.approvalState === "pending" ? <span>等待审批</span> : null}
        <StatusTag status={call.approvalState} />
        <button
          type="button"
          className="act"
          onClick={(event) => {
            event.preventDefault();
            onInspect();
          }}
          aria-label="检查工具调用"
          title="检查工具调用"
        >
          <Settings2 size={14} />
        </button>
        <ChevronDown className="chev" size={14} aria-hidden="true" />
      </summary>
      <div className="tool-call-details">
        <CodeField label="参数" value={prettyJson(call.arguments)} />
        {call.output ? <CodeField label="输出" value={prettyJson(call.output)} /> : null}
        {call.error ? <CodeField label="错误" value={call.error} danger /> : null}
        {call.artifacts.length ? <ImageGallery assets={call.artifacts} /> : null}
      </div>
    </details>
  );
}
