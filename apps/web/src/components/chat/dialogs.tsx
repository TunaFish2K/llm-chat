import { effectiveReasoningSelection, legacyReasoningSelection } from "@llm-chat/contracts";
import { ReasoningSelect } from "../ReasoningControl";
import { toolLabel, toolDescription } from "../../lib/catalog-i18n";
import { t, useLocale } from "../../lib/i18n";
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
import { CONTEXT_POLICIES, INHERIT, NO_MODEL, withGenerationValue } from "./model";
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
  useLocale();
  const [text, setText] = useState(message.text ?? "");
  const { attachments, setAttachments, uploading, uploadFiles } = useAttachments(message.attachments ?? [], message.id);
  const valid = (text.trim().length > 0 || attachments.length > 0) && text.length <= 1_000_000;
  return (
    <Modal
      title={t("dialogs.edit_and_branch")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{t("WorkspaceSidebar.cancel")}</Button>
          <Button variant="primary" onClick={() => onSubmit(text, attachments.map((asset) => asset.id))} disabled={busy || uploading || !valid}>
            {busy ? t("dialogs.creating") : t("dialogs.create_branch_and_generate")}
          </Button>
        </>
      }
    >
      <Field label={t("dialogs.edited_message")}>
        <textarea
          className="textarea"
          rows={7}
          aria-label={t("dialogs.edited_message")}
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
      <p className="small muted">{t("dialogs.saving_immediately_generates_a_reply_in_the_new_branch_the")}</p>
    </Modal>
  );
}

/** Rewind one turn by branching from before it; the original stays intact. */
export function UndoDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => void }) {
  useLocale();
  return (
    <Modal
      title={t("dialogs.undo_last_turn")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("WorkspaceSidebar.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {busy ? t("dialogs.creating") : t("dialogs.create_rollback_branch")}
          </Button>
        </>
      }
    >
      <p>{t("dialogs.creates_a_new_branch_before_the_last_turn_the_original")}</p>
      <p className="small muted">{t("dialogs.only_conversation_context_is_rolled_back_workspace_files_changed_by")}</p>
    </Modal>
  );
}

export function AgentSwitchDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  useLocale();
  return (
    <Modal
      title={t("dialogs.switch_agent")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("WorkspaceSidebar.cancel")}</Button>
          <Button variant="primary" onClick={onConfirm}>{t("dialogs.switch")}</Button>
        </>
      }
    >
      <p>{t("dialogs.history_is_preserved_future_replies_use_the_new_agent_all")}</p>
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
  useLocale();
  const [draft, setDraft] = useState<ConversationExecutionOverrides>(() => structuredClone(value));
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [toolQuery, setToolQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const modelId = Object.hasOwn(draft, "modelId") ? draft.modelId : agent?.execution.modelId ?? agent?.lastSelectedModelId;
  const selectedModel = models.find(model => model.id === modelId);
  const selectedReasoning = draft.reasoningSelection ?? (draft.reasoningEffort !== undefined ? legacyReasoningSelection(draft.reasoningEffort) : undefined);
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
    [toolLabel(tool), tool.name, toolDescription(tool), tool.sourceName]
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
      title={t("dialogs.conversation_execution_settings")}
      onClose={onClose}
      wide
      footer={
        <>
          <Button disabled={saving || !Object.keys(draft).length} onClick={() => setDraft({})}>{t("dialogs.clear_overrides")}</Button>
          <span className="grow" />
          <Button onClick={onClose} disabled={saving}>{t("WorkspaceSidebar.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? t("AgentEditorView.saving") : t("WorkspaceSidebar.save")}
          </Button>
        </>
      }
    >
      <div className="override-editor">
        <p className="muted small">{t("dialogs.applies_only_to_future_generations_in_this_conversation_follow_agent")}</p>

        <div className="form-grid">
          <Field label={t("InspectorPanel.model")}>
            <select
              className="select"
              aria-label={t("dialogs.conversation_model_override")}
              value={Object.hasOwn(draft, "modelId") ? draft.modelId ?? NO_MODEL : INHERIT}
              onChange={(event) => setTop("modelId", event.target.value)}
            >
              <option value={INHERIT}>{t("dialogs.follow_agent", { value1: (models.find((model) => model.id === agent?.execution.modelId)?.displayName ?? t("ConnectionsView.not_configured")) })}</option>
              <option value={NO_MODEL}>{t("dialogs.explicitly_use_no_model")}</option>
              {models
                .filter((model) => model.enabled)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} · {model.modelKey}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t("AgentEditorView.context_policy")}>
            <select
              className="select"
              aria-label={t("AgentEditorView.context_policy")}
              value={draft.contextPolicy ?? INHERIT}
              onChange={(event) => setTop("contextPolicy", event.target.value)}
            >
              <option value={INHERIT}>{t("dialogs.follow_agent", { value1: (agent?.execution.contextPolicy ?? "auto") })}</option>
              {CONTEXT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("ConnectionsView.reasoning_levels")}>
            <ReasoningSelect model={selectedModel} value={selectedReasoning} inherited={effectiveReasoningSelection(agent?.execution ?? {})}
              onChange={selection => setDraft(current => {
                const next = { ...current };
                delete next.reasoningEffort;
                if (selection) next.reasoningSelection = selection;
                else delete next.reasoningSelection;
                return next;
              })} />
          </Field>
        </div>

        <h4>{t("dialogs.common_generation_parameters")}</h4>
        <div className="form-grid">
          <OptionalNumber label={t("ConnectionsView.temperature")} value={common.temperature} min={0} max={2} step={0.1} onChange={(next) => setCommon("temperature", next)} />
          <OptionalNumber label="Top P" value={common.topP} min={0} max={1} step={0.05} onChange={(next) => setCommon("topP", next)} />
          <OptionalNumber
            label={t("ConnectionsView.maximum_output_tokens")}
            value={common.maxOutputTokens}
            min={1}
            max={1_000_000}
            step={1}
            onChange={(next) => setCommon("maxOutputTokens", next)}
          />
          <Field label={t("dialogs.stop_sequences_one_per_line")} wide>
            <textarea
              className="textarea"
              aria-label={t("dialogs.stop_sequences_one_per_line")}
              placeholder={t("dialogs.leave_blank_to_inherit_select_override_to_use_an_empty")}
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
              label={t("dialogs.override_stop_sequences")}
              checked={common.stopSequences !== undefined}
              onChange={(checked) => setCommon("stopSequences", checked ? [] : undefined)}
            />
          </Field>
        </div>

        <h4>{t("dialogs.protocol_parameters")}</h4>
        <div className="form-grid">
          <Field label={t("ConnectionsView.reasoning_summary")}>
            <select
              className="select"
              aria-label={t("ConnectionsView.reasoning_summary")}
              value={protocol.reasoningSummary ?? INHERIT}
              onChange={(event) => setProtocol("reasoningSummary", event.target.value === INHERIT ? undefined : event.target.value)}
            >
              <option value={INHERIT}>{t("dialogs.inherit")}</option>
              <option value="auto">auto</option>
              <option value="concise">concise</option>
              <option value="detailed">detailed</option>
            </select>
          </Field>
          <OptionalNumber
            label={t("dialogs.thinking_budget_tokens")}
            value={protocol.thinkingBudgetTokens}
            min={1024}
            step={1}
            onChange={(next) => setProtocol("thinkingBudgetTokens", next)}
          />
        </div>

        <div className="tool-override-heading">
          <div>
            <h4>{t("dialogs.tool_overrides")}</h4>
            <p className="muted small">{t("dialogs.changes_only_tool_enablement_approval_policy_is_still_set_by")}</p>
          </div>
          <label className="search-field compact">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("dialogs.search_tools")}
              placeholder={t("dialogs.search_tools")}
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
                  <strong>{toolLabel(tool)}</strong>
                  <code>{tool.name}</code>
                  <small>{toolDescription(tool)}</small>
                </div>
                <StatusTag status={tool.available ? "completed" : "failed"} />
                <select
                  className="select"
                  aria-label={t("dialogs.override", { value1: (toolLabel(tool)) })}
                  value={state === undefined ? INHERIT : state ? "on" : "off"}
                  onChange={(event) => setTool(tool.name, event.target.value)}
                >
                  <option value={INHERIT}>{t("dialogs.follow_agent_2")}</option>
                  <option value="on">{t("SettingsView.enable")}</option>
                  <option value="off">{t("AgentEditorView.disable")}</option>
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
  useLocale();
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
        placeholder={t("dialogs.inherit")}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    </Field>
  );
}
