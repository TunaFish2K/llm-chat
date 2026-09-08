import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type {
  AgentSummaryDto,
  ContextPolicy,
  ConversationExecutionOverrides,
  MessageDto,
  ModelDto,
  ReasoningEffort,
  ToolCatalogItemDto
} from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { toastError } from "../../lib/app-state";
import { Button, Field, Modal, StatusTag, Toggle } from "../ui";
import { CONTEXT_POLICIES, INHERIT, NO_MODEL, REASONING_LEVELS, withGenerationValue } from "./model";
import { AttachmentList, AttachmentMenu, useAttachments } from "./AttachmentEditor";

/** Rewrite a user message into a new branch and immediately regenerate. */
export function EditForkDialog({
  message,
  busy,
  onClose,
  onSubmit
}: {
  message: MessageDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string, assetIds: string[]) => void;
}) {
  const [text, setText] = useState(message.text ?? "");
  const { attachments, setAttachments, uploading, uploadFiles } = useAttachments(message.attachments ?? [], message.id);
  const valid = (text.trim().length > 0 || attachments.length > 0) && text.length <= 1_000_000;
  return (
    <Modal
      title="编辑并分叉"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => onSubmit(text, attachments.map((asset) => asset.id))} disabled={busy || uploading || !valid}>
            {busy ? "正在创建…" : "创建分支并生成"}
          </Button>
        </>
      }
    >
      <Field label="修改后的消息">
        <textarea
          className="textarea"
          rows={7}
          aria-label="修改后的消息"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
          onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void uploadFiles([...event.clipboardData.files]); } }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); void uploadFiles([...event.dataTransfer.files]); }}
        />
      </Field>
      <AttachmentList attachments={attachments} setAttachments={setAttachments} disabled={busy || uploading} />
      <AttachmentMenu uploadFiles={uploadFiles} disabled={busy || attachments.length >= 8} uploading={uploading} />
      <p className="small muted">保存后会立即在新分支生成回复。原消息和原会话保持不变。</p>
    </Modal>
  );
}

/** Rewind one turn by branching from before it; the original stays intact. */
export function UndoDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="撤销上一轮"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {busy ? "正在创建…" : "创建回退分支"}
          </Button>
        </>
      }
    >
      <p>将从上一轮之前创建新分支，原会话保持不变。</p>
      <p className="small muted">只回退会话上下文，不恢复 Agent 已修改的工作区文件。</p>
    </Modal>
  );
}

export function AgentSwitchDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="切换 Agent"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm}>
            切换
          </Button>
        </>
      }
    >
      <p>历史消息会保留；后续回复使用新 Agent。当前会话的模型、上下文、推理和工具覆盖将全部清除。</p>
    </Modal>
  );
}

/**
 * Full per-conversation execution override editor.
 *
 * Every control has a "跟随 Agent" position that *deletes* the field rather
 * than writing a value, so an untouched setting keeps inheriting even if the
 * Agent later changes.
 */
export function ExecutionOverridesDialog({
  value,
  agent,
  models,
  onClose,
  onSave
}: {
  value: ConversationExecutionOverrides;
  agent: AgentSummaryDto | undefined;
  models: ModelDto[];
  onClose: () => void;
  onSave: (value: ConversationExecutionOverrides) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConversationExecutionOverrides>(() => structuredClone(value));
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [toolQuery, setToolQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const common = draft.generation?.common ?? {};
  const protocol = draft.generation?.protocol ?? {};

  useEffect(() => {
    void endpoints.toolCatalog().then(setCatalog).catch(toastError);
  }, []);

  const setTop = (key: "modelId" | "contextPolicy" | "reasoningEffort", next: string) =>
    setDraft((current) => {
      const output = structuredClone(current);
      if (next === INHERIT) delete output[key];
      else if (key === "modelId") output.modelId = next === NO_MODEL ? null : next;
      else if (key === "contextPolicy") output.contextPolicy = next as ContextPolicy;
      else output.reasoningEffort = next as ReasoningEffort;
      return output;
    });
  const setCommon = (
    key: "temperature" | "topP" | "maxOutputTokens" | "stopSequences",
    next: number | string[] | undefined
  ) => setDraft((current) => withGenerationValue(current, "common", key, next));
  const setProtocol = (key: "reasoningSummary" | "thinkingBudgetTokens", next: string | number | undefined) =>
    setDraft((current) => withGenerationValue(current, "protocol", key, next));
  const setTool = (name: string, next: string) =>
    setDraft((current) => {
      const tools = { ...(current.tools ?? {}) };
      if (next === INHERIT) delete tools[name];
      else tools[name] = next === "on";
      const output = { ...current };
      if (Object.keys(tools).length) output.tools = tools;
      else delete output.tools;
      return output;
    });

  const visibleTools = catalog.filter((tool) =>
    [tool.label, tool.name, tool.description, tool.sourceName]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(toolQuery.trim().toLocaleLowerCase())
  );

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="会话执行设置"
      onClose={onClose}
      wide
      footer={
        <>
          <Button disabled={saving || !Object.keys(draft).length} onClick={() => setDraft({})}>
            清除覆盖
          </Button>
          <span className="grow" />
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="override-editor">
        <p className="muted small">仅影响当前会话的后续生成。设为“跟随 Agent”会删除对应覆盖字段。</p>

        <div className="form-grid">
          <Field label="模型">
            <select
              className="select"
              aria-label="会话模型覆盖"
              value={Object.hasOwn(draft, "modelId") ? draft.modelId ?? NO_MODEL : INHERIT}
              onChange={(event) => setTop("modelId", event.target.value)}
            >
              <option value={INHERIT}>
                跟随 Agent · {models.find((model) => model.id === agent?.execution.modelId)?.displayName ?? "未配置"}
              </option>
              <option value={NO_MODEL}>明确不使用模型</option>
              {models
                .filter((model) => model.enabled)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {model.modelKey}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="上下文策略">
            <select
              className="select"
              aria-label="上下文策略"
              value={draft.contextPolicy ?? INHERIT}
              onChange={(event) => setTop("contextPolicy", event.target.value)}
            >
              <option value={INHERIT}>跟随 Agent · {agent?.execution.contextPolicy ?? "auto"}</option>
              {CONTEXT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </Field>
          <Field label="推理档位">
            <select
              className="select"
              aria-label="推理档位"
              value={draft.reasoningEffort ?? INHERIT}
              onChange={(event) => setTop("reasoningEffort", event.target.value)}
            >
              <option value={INHERIT}>跟随 Agent · {agent?.execution.reasoningEffort ?? "none"}</option>
              {REASONING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <h4>通用生成参数</h4>
        <div className="form-grid">
          <OptionalNumber label="温度" value={common.temperature} min={0} max={2} step={0.1} onChange={(next) => setCommon("temperature", next)} />
          <OptionalNumber label="Top P" value={common.topP} min={0} max={1} step={0.05} onChange={(next) => setCommon("topP", next)} />
          <OptionalNumber
            label="最大输出 token"
            value={common.maxOutputTokens}
            min={1}
            max={1_000_000}
            step={1}
            onChange={(next) => setCommon("maxOutputTokens", next)}
          />
          <Field label="停止序列（每行一个）" wide>
            <textarea
              className="textarea"
              aria-label="停止序列（每行一个）"
              placeholder="留空表示继承；勾选后可覆盖为空列表"
              disabled={common.stopSequences === undefined}
              value={(common.stopSequences ?? []).join("\n")}
              onChange={(event) =>
                setCommon(
                  "stopSequences",
                  event.target.value
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean)
                )
              }
            />
            <Toggle
              label="覆盖停止序列"
              checked={common.stopSequences !== undefined}
              onChange={(checked) => setCommon("stopSequences", checked ? [] : undefined)}
            />
          </Field>
        </div>

        <h4>协议参数</h4>
        <div className="form-grid">
          <Field label="推理摘要">
            <select
              className="select"
              aria-label="推理摘要"
              value={protocol.reasoningSummary ?? INHERIT}
              onChange={(event) => setProtocol("reasoningSummary", event.target.value === INHERIT ? undefined : event.target.value)}
            >
              <option value={INHERIT}>继承</option>
              <option value="auto">auto</option>
              <option value="concise">concise</option>
              <option value="detailed">detailed</option>
            </select>
          </Field>
          <OptionalNumber
            label="Thinking 预算（token）"
            value={protocol.thinkingBudgetTokens}
            min={1024}
            step={1}
            onChange={(next) => setProtocol("thinkingBudgetTokens", next)}
          />
        </div>

        <div className="tool-override-heading">
          <div>
            <h4>工具覆盖</h4>
            <p className="muted small">只改变工具是否启用，审批策略仍由 Agent 决定。</p>
          </div>
          <label className="search-field compact">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索工具"
              placeholder="搜索工具"
              value={toolQuery}
              onChange={(event) => setToolQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="tool-override-list">
          {visibleTools.map((tool) => {
            const state = draft.tools?.[tool.name];
            return (
              <div className="tool-override-row" key={tool.name}>
                <div>
                  <strong>{tool.label}</strong>
                  <code>{tool.name}</code>
                  <small>{tool.description}</small>
                </div>
                <StatusTag status={tool.available ? "completed" : "failed"} />
                <select
                  className="select"
                  aria-label={`${tool.label} 覆盖`}
                  value={state === undefined ? INHERIT : state ? "on" : "off"}
                  onChange={(event) => setTool(tool.name, event.target.value)}
                >
                  <option value={INHERIT}>跟随 Agent</option>
                  <option value="on">启用</option>
                  <option value="off">停用</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

function OptionalNumber({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <input
        className="input"
        type="number"
        aria-label={label}
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        placeholder="继承"
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    </Field>
  );
}
