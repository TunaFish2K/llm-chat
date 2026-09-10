import { useStickToBottom } from "./useStickToBottom";
import { isOffline, offlineStore } from "../../lib/offline-history";
import { ToolCallContent, ToolCallSummary } from "./ToolPresentation";
import { useState, type ReactNode } from "react";
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
import { CancelGenerationButton } from "./CancelGenerationButton";
import type { GenerationDto, ImageGenerationJobDto, MessageDto, ToolCallDto } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { appStore, isGenerationActive, loadMessages, toastError } from "../../lib/app-state";
import type { ConversationBranchGroup } from "../../lib/conversation-tree";
import { formatCachedTokens, formatTime, formatTokens } from "../../lib/format";
import type { InspectionTarget } from "../../lib/inspection";
import { Markdown } from "../../lib/markdown";
import { useStore } from "../../lib/store";
import { StatusTag } from "../ui";
import { AssetGallery, copyText, MessageAction } from "./atoms";
import { activeGeneration, answerText, groupTimeline, type ImageJobsByToolCall, type ProcessEntry } from "./model";

function toolStderr(output: string | null): string {
  if (!output) return "";
  try { const value = JSON.parse(output); return typeof value.stderr === "string" && value.stderr.trim() ? `：${value.stderr.trim().slice(-250)}` : ""; }
  catch { return ""; }
}

export interface StreamCallbacks {
  onInspect: (target: InspectionTarget) => void;
  onEdit: (message: MessageDto) => void;
  onRetry: (assistantMessageId: string) => void;
  onContinue: (messageId: string) => void;
  onGreetingFork: (message: MessageDto, greetingIndex: number) => void;
  onBranchChange: (conversationId: string) => void;
  /** True while a fork, retry request or generation is in flight; blocks new generation actions. */
  branching: boolean;
}

/** One turn in the transcript. */
export function MessageItem({
  conversationId,
  message,
  branchGroups = [],
  retryTargetId,
  imageJobs,
  callbacks
}: {
  conversationId: string;
  message: MessageDto;
  branchGroups?: ConversationBranchGroup[];
  retryTargetId?: string | undefined;
  imageJobs?: ImageJobsByToolCall | undefined;
  callbacks: StreamCallbacks;
}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const imageJob = message.imageGenerationJob ?? null;
  const generation = message.role === "assistant" ? activeGeneration(message) : null;
  const generatedAgent = message.greeting?.agent ?? generation?.generatedAgent;

  if (message.role === "user") {
    return (
      <article className="msg" data-role="user">
        {attachments.length ? <AssetGallery assets={attachments} /> : null}
        {message.text ? <div className="msg-bubble">{message.text}</div> : null}
        <MessageFooter metadata={<time>{formatTime(message.createdAt)}</time>}>
          <MessageAction label="复制消息" onClick={() => void copyText(message.text ?? "")}>
            <Copy size={14} />
          </MessageAction>
          <MessageAction label="编辑并分叉" disabled={callbacks.branching} onClick={() => callbacks.onEdit(message)}>
            <Pencil size={14} />
          </MessageAction>
          <span title={retryTargetId ? "重新生成对应回答" : "尚无可重试的回答"}>
            <MessageAction label="重试回答" disabled={callbacks.branching || !retryTargetId} onClick={() => retryTargetId && callbacks.onRetry(retryTargetId)}>
              <RotateCcw size={14} />
            </MessageAction>
          </span>
          <BranchSwitchers groups={branchGroups} onChange={callbacks.onBranchChange} />
        </MessageFooter>
      </article>
    );
  }

  return (
    <article className="msg" data-role="assistant" aria-label={generatedAgent?.name ?? "助手回复"}>
      {attachments.length ? <AssetGallery assets={attachments} /> : null}
      {generation ? (
        <GenerationTimeline
          conversationId={conversationId}
          message={message}
          generation={generation}
          imageJobs={imageJobs}
          branchGroups={branchGroups}
          callbacks={callbacks}
        />
      ) : message.text ? (
        <>
          <Markdown text={message.text} />
          <MessageFooter metadata={<span>{generatedAgent?.name ?? "助手"} · {message.greeting ? "开场白" : "历史回复"} · {formatTime(message.createdAt)}</span>}>
              <MessageAction label="复制回答" onClick={() => void copyText(message.text ?? "")}><Clipboard size={14} /></MessageAction>
                {message.greeting && message.greeting.variants.length > 1 ? (
                  <VersionSwitcher
                    label="开场白切换"
                    index={message.greeting.activeIndex}
                    total={message.greeting.variants.length}
                    disabled={callbacks.branching}
                    onChange={(index) => callbacks.onGreetingFork(message, index)}
                  />
                ) : null}
                <BranchSwitchers groups={branchGroups} onChange={callbacks.onBranchChange} />
          </MessageFooter>
        </>
      ) : attachments.length ? null : imageJob ? (
        <ImageGenerationStatus conversationId={conversationId} job={imageJob} />
      ) : (
        <p className="muted">（无生成内容）</p>
      )}
    </article>
  );
}

function ImageGenerationStatus({ conversationId, job }: { conversationId: string; job: ImageGenerationJobDto }) {
  const offline = useStore(offlineStore, (state) => state.offline);
  const label = job.status === "queued"
    ? "图片任务排队中"
    : job.status === "running"
    ? "正在生成图片"
    : job.status === "waiting-provider"
    ? "等待图片服务完成"
    : job.status === "failed"
    ? `图片生成失败：${job.error?.message ?? "未知错误"}`
    : job.status === "cancelled"
    ? "图片生成已取消"
    : "图片已生成";
  const active = job.status === "queued" || job.status === "running" || job.status === "waiting-provider";
  const retryable = job.status === "failed" || job.status === "cancelled";
  return (
    <div className={job.status === "failed" ? "refusal-block" : "image-job-status"} role={job.status === "failed" ? "alert" : "status"}>
      <span>{label}</span>
      {active ? (
        <MessageAction
          label="停止图片生成"
          danger
          disabled={offline}
          onClick={() => void endpoints.cancelImageGeneration(job.id).then(() => loadMessages(conversationId)).catch(toastError)}
        >
          <Square size={14} fill="currentColor" />
        </MessageAction>
      ) : retryable ? (
        <MessageAction
          label="重试图片生成"
          disabled={offline}
          onClick={() => void endpoints.retryImageGeneration(job.id).then(() => loadMessages(conversationId)).catch(toastError)}
        >
          <RotateCcw size={14} />
        </MessageAction>
      ) : null}
    </div>
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
  imageJobs,
  branchGroups,
  callbacks
}: {
  conversationId: string;
  message: MessageDto;
  generation: GenerationDto;
  imageJobs?: ImageJobsByToolCall | undefined;
  branchGroups: ConversationBranchGroup[];
  callbacks: StreamCallbacks;
}) {
  const settings = useStore(appStore, (state) => state.settings);
  const collapsePolicy = settings?.uiPreferences.reasoningCollapsePolicy ?? "collapse-on-answer";
  const offline = useStore(offlineStore, (state) => state.offline);
  const busy = !offline && isGenerationActive(generation.status);
  const timeline = groupTimeline(generation, imageJobs);
  const answer = answerText(generation);
  const versionIndex = message.generations.findIndex((item) => item.id === generation.id);

  const selectVersion = async (id: string) => {
    if (isOffline()) {
      appStore.set((state) => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] ?? []).map((item) => item.id === message.id ? { ...item, activeGenerationId: id, generatedModel: null } : item) } }));
      return;
    }
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
        if (item.kind === "process") {
          const first = item.entries[0]!;
          const key = first.kind === "block" ? `block:${first.block.stepIndex}:${first.block.index}` : `tool:${first.call.id}`;
          return <ProcessGroup key={`${generation.id}:${key}`} entries={item.entries} busy={busy} status={generation.status}
            imageJobs={imageJobs}
            autoOpen={collapsePolicy === "never-auto-collapse" || (collapsePolicy === "collapse-on-answer" && !item.followedByAnswer && busy)}
            onInspect={(toolCallId) => callbacks.onInspect({ kind: "tool", messageId: message.id, generationId: generation.id, toolCallId })} />;
        }
        if (item.kind === "image-result") {
          return item.jobs.length ? <div className="image-tool-results" key={`${generation.id}:image:${item.call.id}`}>
            {item.jobs.map((job) => <div key={job.id} className="image-tool-result" data-image-job-id={job.id}>
              {job.status !== "completed" || !job.outputAssets.length ? <ImageGenerationStatus conversationId={conversationId} job={job} /> : null}
              {job.outputAssets.length ? <AssetGallery assets={job.outputAssets} /> : null}
            </div>)}
          </div> : null;
        }
        const { block } = item;
        const blockKey = `${generation.id}:block:${block.stepIndex}:${block.index}`;
        if (block.type === "refusal") {
          return (
            <div className="refusal-block" role="alert" key={blockKey}>
              <strong>模型拒绝回答</strong>
              <p>{block.content}</p>
            </div>
          );
        }
        if (block.type === "unsupported") {
          return (
            <div className="unsupported-block" key={blockKey}>
              不支持的内容块：{block.content}
            </div>
          );
        }
        return <Markdown key={blockKey} text={block.content} streaming={!block.complete} />;
      })}

      {!busy && !generation.error && generation.status !== "completed" ? <div role="status"><StatusTag status={generation.status} /></div> : null}
      {!busy && !timeline.length && !generation.error && generation.status === "completed" ? <p className="small muted">（无生成内容）</p> : null}
      {generation.error ? (
        <div className="refusal-block" role="alert">
          <strong>生成失败（{generation.error.code}）</strong>
          <p>{generation.error.message}</p>
        </div>
      ) : null}
      {generation.stopReason && generation.status !== "completed" ? (
        <p className="muted small">停止原因：{generation.stopReason}</p>
      ) : null}

      {offline && isGenerationActive(generation.status) ? <p className="hint">截至上次同步，生成状态尚未更新</p> : null}
      <MessageFooter busy={busy} liveAction={busy ? <CancelGenerationButton generationId={generation.id} className="act danger" /> : null}
        metadata={<>
          <span className="reply-identity" title={`${generation.generatedAgent?.name ?? "助手"} · ${message.generatedModel?.connectionName ?? generation.connectionName} / ${message.generatedModel?.displayName ?? generation.modelKey}`}>
            {generation.generatedAgent?.name ?? "助手"} · {message.generatedModel?.connectionName ?? generation.connectionName} / {message.generatedModel?.displayName ?? generation.modelKey}
          </span>
          <button type="button" className="usage-summary" aria-label="查看生成用量" onClick={inspectGeneration}>
            {generation.usage.inputTokens !== undefined ? <span>↑ {formatTokens(generation.usage.inputTokens)}</span> : null}
            {generation.usage.outputTokens !== undefined ? <span>↓ {formatTokens(generation.usage.outputTokens)}</span> : null}
            {generation.usage.cachedInputTokens !== undefined ? (
              <span>缓存 {formatCachedTokens(generation.usage.cachedInputTokens, generation.usage.inputTokens).replace(" tokens", "")}</span>
            ) : null}
            {generation.completedAt ? <span>{(Math.max(0, generation.completedAt - generation.createdAt) / 1000).toFixed(1)}s</span> : null}
          </button>
          <time className="reply-timestamp">{formatTime(message.createdAt)}</time>
        </>}>
          {answer ? (
            <MessageAction label="复制回答" onClick={() => void copyText(answer)}>
              <Clipboard size={14} />
            </MessageAction>
          ) : null}
          {!busy ? (
            <>
              <MessageAction label="重试" disabled={callbacks.branching} onClick={() => callbacks.onRetry(message.id)}>
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
          ) : null}
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
          <BranchSwitchers groups={branchGroups} onChange={callbacks.onBranchChange} />
      </MessageFooter>
    </div>
  );
}

function MessageFooter({ metadata, children, liveAction, busy = false }: {
  metadata: ReactNode; children: ReactNode; liveAction?: ReactNode; busy?: boolean;
}) {
  return <footer className="reply-footer">
    <div className="reply-inline">
      <div className="reply-metadata">{metadata}</div>
      <div className="stream-actions">{children}{busy ? liveAction : null}</div>
    </div>
  </footer>;
}

function ProcessGroup({ entries, busy, status, autoOpen, onInspect, imageJobs }: {
  entries: ProcessEntry[]; busy: boolean; status: GenerationDto["status"]; autoOpen: boolean; onInspect: (id: string) => void;
  imageJobs?: ImageJobsByToolCall | undefined;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? autoOpen;
  const tools = entries.flatMap((entry) => entry.kind === "tool" ? [entry.call] : []);
  const pending = tools.find((call) => call.approvalState === "pending");
  const activeTool = tools.find((call) => !call.completedAt && !call.error && call.approvalState !== "denied");
  const thinking = entries.some((entry) => entry.kind === "block" && !entry.block.complete);
  const active = busy && Boolean(pending || activeTool || thinking);
  const incomplete = thinking || Boolean(activeTool);
  const label = !busy && incomplete && status !== "completed" ? (status === "failed" ? "处理失败" : "处理已停止") : pending ? "等待审批" : activeTool && busy ? `正在调用 ${activeTool.name}` : active ? "正在推理" : "推理过程";
  return <div className="process-group">
    <details className="process-disclosure" open={open}>
      <summary onClick={(event) => { event.preventDefault(); setManualOpen(!open); }}>
        {active ? <LoaderCircle size={13} className="spin" /> : <Gauge size={13} />}
        <span role={active ? "status" : undefined}>{label}</span>
        {tools.length ? <span className="process-count">{tools.length} 次工具调用</span> : null}
        <ChevronDown size={13} className="chev" />
      </summary>
      <div className="process-steps">
        {entries.map((entry) => entry.kind === "tool"
          ? <ToolCallDisclosure key={entry.call.id} call={entry.call} imageJobs={imageJobs?.get(entry.call.id)} onInspect={() => onInspect(entry.call.id)} />
          : <ReasoningContent key={`block:${entry.block.stepIndex}:${entry.block.index}`} content={entry.block.content} open={open} busy={busy} />)}
      </div>
    </details>
    {!open ? tools.filter((call) => call.error && !imageJobs?.get(call.id)?.some((job) => job.error?.message === call.error)).map((call) => <div key={call.id} className="process-error" role="alert">
      <button className="link-button" onClick={() => onInspect(call.id)}>{call.name}</button>：{call.error}{toolStderr(call.output)}
    </div>) : null}
  </div>;
}

function ReasoningContent({ content, open, busy }: { content: string; open: boolean; busy: boolean }) {
  const scroll = useStickToBottom([content], open, { initialFollowing: busy, preservePosition: true });
  return <div className="process-reasoning">
    <div ref={scroll.ref} onScroll={scroll.onScroll} data-following-bottom={!scroll.detached || undefined} tabIndex={0} role="region" aria-label="推理内容">
      <div ref={scroll.contentRef}>{content}</div>
    </div>
  </div>;
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
  const itemName = label.includes("开场白") ? "条开场白" : label.includes("分支") ? "分支" : "版本";
  return (
    <span className="version-switch" aria-label={label}>
      <button
        type="button"
        aria-label={`上一${itemName}`}
        disabled={disabled || index <= 0}
        onClick={() => onChange(index - 1)}
      >
        <ChevronLeft size={14} />
      </button>
      <span>{index + 1} / {total}</span>
      <button
        type="button"
        aria-label={`下一${itemName}`}
        disabled={disabled || index >= total - 1}
        onClick={() => onChange(index + 1)}
      >
        <ChevronRight size={14} />
      </button>
    </span>
  );
}

export function BranchSwitchers({
  groups,
  onChange
}: {
  groups: ConversationBranchGroup[];
  onChange: (conversationId: string) => void;
}) {
  return groups.length ? groups.map((group) => (
    <VersionSwitcher
      key={group.id}
      label="对话分支切换"
      index={group.activeIndex}
      total={group.conversationIds.length}
      onChange={(index) => {
        const conversationId = group.conversationIds[index];
        if (conversationId) onChange(conversationId);
      }}
    />
  )) : null;
}

/** Collapsed by default: arguments and output are inspection material, not prose. */
function ToolCallDisclosure({ call, onInspect, imageJobs }: { call: ToolCallDto; onInspect: () => void; imageJobs?: readonly ImageGenerationJobDto[] | undefined }) {
  const inlineAssets = new Set(imageJobs?.flatMap((job) => job.outputAssets.map((asset) => asset.id)));
  const artifacts = call.artifacts.filter((asset) => !inlineAssets.has(asset.id));
  return (
    <details className="tool-call" data-state={call.approvalState}>
      <summary>
        <Wrench size={15} aria-hidden="true" />
        <code className="tool-call-name" title={call.name}>{call.name}</code>
        <ToolCallSummary call={call} />
        {call.error ? <span className="tool-error-summary" title={call.error}>{call.error}{toolStderr(call.output)}</span> : null}
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
        <ToolCallContent key={call.id} call={call} />
        {artifacts.length ? <AssetGallery assets={artifacts} /> : null}
      </div>
    </details>
  );
}
