import { effectiveReasoningSelection } from "@llm-chat/contracts";
import { EnvironmentSettings } from "../components/EnvironmentSettings";
import { ReasoningSelect } from "../components/ReasoningControl";
import { toolLabel, toolDescription, toolError, skillName, skillDescription } from "../lib/catalog-i18n";
import { useErrorState } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type {
  AgentDto,
  ApprovalPolicy,
  CharacterBook,
  ContextPolicy,
  GenerationOverrides,
  SkillDto,
  ToolCatalogItemDto,
  ToolPolicy
} from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { appStore, refreshAgents, toast, toastError } from "../lib/app-state";
import { fileToBase64 } from "../lib/format";
import { navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, ErrorState, Field, LoadingState, Switch } from "../lib/ui";
import { ExpandableTextarea } from "../components/ExpandableTextarea";
import { RoleplayTab } from "../components/agent/RoleplayTab";

const CONTEXT_POLICIES: ContextPolicy[] = ["auto", "trim", "summarize", "full"];
function getTABS() { return [
  ["card", t("AgentEditorView.character_card")],
  ["roleplay", t("AgentEditorView.roleplay")],
  ["avatar", t("AgentEditorView.avatar")],
  ["execution", t("AgentEditorView.execution_settings")],
  ["tools", t("SettingsView.tools")],
  ["skills", "Skill"],
  ["user", t("SettingsView.user_profile")]
] as const; }
type Tab = ReturnType<typeof getTABS>[number][0];

export function AgentEditorView({ agentId }: { agentId: string }) {
  useLocale();
  const [agent, setAgent] = useState<AgentDto | null>(null);
  const [error, setError] = useErrorState(null);
  const [tab, setTab] = useState<Tab>("card");
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leavePath, setLeavePath] = useState<string | null>(null);
  const allowLeave = useRef(false);
  useEffect(() => {
    const guard = (event: Event) => {
      if (!dirty || allowLeave.current) return;
      event.preventDefault();
      setLeavePath((event as CustomEvent<{ path: string }>).detail.path);
    };
    window.addEventListener("llm-chat:before-navigate", guard);
    return () => window.removeEventListener("llm-chat:before-navigate", guard);
  }, [dirty]);


  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setError(null);
    setDirty(false);
    Promise.all([endpoints.agent(agentId), endpoints.toolCatalog(agentId), endpoints.skills()])
      .then(([agentData, catalogData, skillData]) => {
        if (cancelled) return;
        setAgent(agentData);
        setCatalog(catalogData);
        setSkills(skillData);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause : t("AgentEditorView.could_not_load_agent"));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (resource === "agents" && !dirty) void endpoints.agent(agentId).then(setAgent).catch(toastError);
      if (resource === "tools" || (resource === "agents" && !dirty)) {
        void endpoints.toolCatalog(agentId).then(setCatalog).catch(toastError);
      }
      if (resource === "skills") void endpoints.skills().then(setSkills).catch(toastError);
    };
    window.addEventListener("llm-chat:resource-changed", refresh);
    return () => window.removeEventListener("llm-chat:resource-changed", refresh);
  }, [agentId, dirty]);

  const mutate = (fn: (draft: AgentDto) => void) => {
    setAgent((current) => {
      if (!current) return current;
      const next: AgentDto = JSON.parse(JSON.stringify(current)) as AgentDto;
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      const updated = await endpoints.updateAgent(agent.id, {
        card: agent.card,
        execution: agent.execution,
        userProfile: agent.userProfile,
        roleplay: agent.roleplay
      });
      setAgent(updated);
      setDirty(false);
      await refreshAgents();
      toast("success", localized("AgentEditorView.agent_saved"));
    } catch (cause) {
      toastError(cause);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="panel-scroll">
        <div className="panel-inner">
          <ErrorState message={error} onRetry={() => navigate(routes.agents())} />
        </div>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="panel-scroll">
        <LoadingState label={t("AgentEditorView.loading_agent")} />
      </div>
    );
  }

  return (
    <>
      <div className="page-header mobile-redundant-title">
        <h2>
          {agent.name}
          {agent.protected ? <span className="tag accent" style={{ marginLeft: 8 }}>{t("SettingsView.built_in")}</span> : null}
        </h2>
        <div className="actions">
          <button className="btn" onClick={() => navigate(routes.agents())}>{t("AgentEditorView.back_to_list")}</button>
          <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("AgentEditorView.saving") : dirty ? t("AgentEditorView.save_changes") : t("AgentEditorView.saved")}
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {getTABS().map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="panel-scroll">
        <div className="panel-inner">
          {tab === "card" ? <CardTab agent={agent} mutate={mutate} /> : null}
          {tab === "roleplay" ? (
            <RoleplayTab
              agent={agent}
              mutate={mutate}
              onReplace={(next) => {
                setAgent(next);
                setDirty(false);
              }}
            />
          ) : null}
          {tab === "avatar" ? <AvatarTab agent={agent} onChanged={(next) => setAgent(next)} /> : null}
          {tab === "execution" ? <ExecutionTab agent={agent} mutate={mutate} /> : null}
          {tab === "tools" ? (
            <ToolsTab
              agent={agent}
              mutate={mutate}
              catalog={catalog}
            />
          ) : null}
          {tab === "skills" ? <SkillsTab agent={agent} mutate={mutate} skills={skills} /> : null}
          {tab === "user" ? <UserProfileTab agent={agent} mutate={mutate} /> : null}
        </div>
      </div>
      {leavePath ? <ConfirmModal title={t("AgentEditorView.discard_unsaved_changes")} message={t("AgentEditorView.changes_to_this_agent_have_not_been_saved")} confirmLabel={t("AgentEditorView.discard_changes")}
        onClose={() => setLeavePath(null)} onConfirm={() => {
          allowLeave.current = true;
          navigate(leavePath);
          allowLeave.current = false;
          setLeavePath(null);
        }} /> : null}
    </>
  );
}

function CardTab({ agent, mutate }: { agent: AgentDto; mutate: (fn: (draft: AgentDto) => void) => void }) {
  useLocale();
  const data = agent.card.data;
  const setField = (key: string, value: unknown) =>
    mutate((draft) => {
      (draft.card.data as unknown as Record<string, unknown>)[key] = value;
    });
  const [bookJson, setBookJson] = useState(() => JSON.stringify(data.character_book ?? null, null, 2));
  const [bookError, setBookError] = useErrorState(null);

  return (
    <div>
      <Field label={t("SettingsView.name")} htmlFor="agent-name">
        <input
          id="agent-name"
          className="input"
          value={data.name}
          onChange={(event) => setField("name", event.target.value)}
        />
      </Field>
      <Field label={t("SettingsView.description")}>
        <ExpandableTextarea
          label={t("AgentEditorView.character_description")}
          value={data.description}
          onChange={(value) => setField("description", value)}
        />
      </Field>
      <div className="grid-2">
        <Field label={t("AgentEditorView.personality")}>
          <ExpandableTextarea
            label={t("AgentEditorView.character_personality")}
            value={data.personality}
            onChange={(value) => setField("personality", value)}
          />
        </Field>
        <Field label={t("AgentEditorView.scenario")}>
          <ExpandableTextarea
            label={t("AgentEditorView.character_scenario")}
            value={data.scenario}
            onChange={(value) => setField("scenario", value)}
          />
        </Field>
      </div>
      <Field label={t("ChatView.greeting")}>
        <ExpandableTextarea
          label={t("ChatView.greeting")}
          value={data.first_mes}
          onChange={(value) => setField("first_mes", value)}
        />
      </Field>
      <div className="field greeting-editor">
        <div className="field-heading">
          <div>
            <label>{t("AgentEditorView.alternate_greetings")}</label>
            <span className="hint">{t("AgentEditorView.each_greeting_can_span_multiple_lines_preview_and_switch_greetings")}</span>
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() => setField("alternate_greetings", [...data.alternate_greetings, ""])}
          >
            <Plus size={15} aria-hidden="true" />{t("AgentEditorView.add")}</button>
        </div>
        {data.alternate_greetings.length === 0 ? (
          <p className="small muted">{t("AgentEditorView.no_alternate_greetings_yet")}</p>
        ) : (
          <div className="greeting-editor-list">
            {data.alternate_greetings.map((greeting, index) => (
              <div className="greeting-editor-item" key={index}>
                <div className="greeting-editor-item-header">
                  <span>{t("AgentEditorView.alternative", { value1: (index + 1) })}</span>
                  <div className="row compact">
                    <button
                      type="button"
                      className="btn ghost icon"
                      title={t("AgentEditorView.move_up")}
                      aria-label={t("AgentEditorView.move_alternate_greeting_up", { value1: (index + 1) })}
                      disabled={index === 0}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.map((item, itemIndex) =>
                        itemIndex === index - 1 ? greeting : itemIndex === index ? data.alternate_greetings[index - 1] : item
                      ))}
                    ><ArrowUp size={15} /></button>
                    <button
                      type="button"
                      className="btn ghost icon"
                      title={t("AgentEditorView.move_down")}
                      aria-label={t("AgentEditorView.move_alternate_greeting_down", { value1: (index + 1) })}
                      disabled={index === data.alternate_greetings.length - 1}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.map((item, itemIndex) =>
                        itemIndex === index + 1 ? greeting : itemIndex === index ? data.alternate_greetings[index + 1] : item
                      ))}
                    ><ArrowDown size={15} /></button>
                    <button
                      type="button"
                      className="btn ghost icon danger"
                      title={t("WorkspaceSidebar.delete_2")}
                      aria-label={t("AgentEditorView.delete_alternate_greeting", { value1: (index + 1) })}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.filter((_, itemIndex) => itemIndex !== index))}
                    ><Trash2 size={15} /></button>
                  </div>
                </div>
                <ExpandableTextarea
                  label={t("AgentEditorView.alternate_greeting", { value1: (index + 1) })}
                  value={greeting}
                  onChange={(value) => setField("alternate_greetings", data.alternate_greetings.map((item, itemIndex) =>
                    itemIndex === index ? value : item
                  ))}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <Field label={t("AgentEditorView.example_dialogue")}>
        <ExpandableTextarea
          label={t("AgentEditorView.example_dialogue")}
          value={data.mes_example}
          onChange={(value) => setField("mes_example", value)}
        />
      </Field>
      <Field label={t("AgentEditorView.base_system_prompt")} hint={t("AgentEditorView.applies_only_to_this_agent_used_when_the_character_card")}>
        <ExpandableTextarea label={t("AgentEditorView.base_system_prompt")} value={agent.execution.baseSystemPrompt ?? ""}
          onChange={(value) => mutate((draft) => { draft.execution.baseSystemPrompt = value; })} />
      </Field>
      <Field label={t("AgentEditorView.system_prompt")} hint={t("AgentEditorView.the_character_card_system_prompt_overrides_the_base_prompt_use")}>
        <ExpandableTextarea
          label={t("AgentEditorView.system_prompt")}
          value={data.system_prompt}
          onChange={(value) => setField("system_prompt", value)}
        />
      </Field>
      <Field label={t("AgentEditorView.post_history_instructions")}>
        <ExpandableTextarea
          label={t("AgentEditorView.post_history_instructions")}
          value={data.post_history_instructions}
          onChange={(value) => setField("post_history_instructions", value)}
        />
      </Field>
      <Field label={t("AgentEditorView.creator_notes")}>
        <ExpandableTextarea
          label={t("AgentEditorView.creator_notes")}
          value={data.creator_notes}
          onChange={(value) => setField("creator_notes", value)}
        />
      </Field>
      <div className="grid-2">
        <Field label={t("AgentEditorView.tags")} hint={t("AgentEditorView.comma_separated")}>
          <input
            className="input"
            aria-label={t("AgentEditorView.tags")}
            value={data.tags.join(", ")}
            onChange={(event) =>
              setField(
                "tags",
                event.target.value
                  .split(/[,，]/)
                  .map((item) => item.trim())
                  .filter(Boolean)
              )
            }
          />
        </Field>
        <Field label={t("AgentEditorView.creator")}>
          <input
            className="input"
            aria-label={t("AgentEditorView.creator")}
            value={data.creator}
            onChange={(event) => setField("creator", event.target.value)}
          />
        </Field>
      </div>
      <Field label={t("AgentEditorView.character_version")}>
        <input
          className="input"
          aria-label={t("AgentEditorView.character_version")}
          value={data.character_version}
          onChange={(event) => setField("character_version", event.target.value)}
        />
      </Field>
      <Field label={t("AgentEditorView.character_book_json")} hint={t("AgentEditorView.keep_null_to_disable")}>
        <ExpandableTextarea
          label={t("AgentEditorView.character_book_json_2")}
          mono
          value={bookJson}
          onChange={(value) => {
            setBookJson(value);
            try {
              const parsed = JSON.parse(value) as CharacterBook | null;
              setBookError(null);
              setField("character_book", parsed ?? undefined);
            } catch {
              setBookError(localized("AgentEditorView.invalid_json_fix_it_before_saving"));
            }
          }}
        />
        {bookError ? (
          <span className="hint" role="alert" style={{ color: "var(--danger)" }}>
            {bookError}
          </span>
        ) : null}
      </Field>
    </div>
  );
}

function AvatarTab({ agent, onChanged }: { agent: AgentDto; onChanged: (agent: AgentDto) => void }) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      const updated = await endpoints.setAgentAvatar(agent.id, file.name, dataBase64);
      onChanged(updated);
      await refreshAgents();
      toast("success", localized("AgentEditorView.avatar_updated"));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>{t("AgentEditorView.avatar")}</h3>
      <div className="row">
        {agent.hasAvatar ? (
          <img
            className="avatar-img"
            style={{ width: 96, height: 96 }}
            src={`/api/agents/${agent.id}/avatar?t=${agent.updatedAt}`}
            alt={t("AgentEditorView.avatar_for", { value1: (agent.name) })}
          />
        ) : (
          <span className="avatar-placeholder" style={{ width: 96, height: 96, fontSize: 32 }} aria-hidden="true">
            {agent.name.slice(0, 1)}
          </span>
        )}
        <div>
          <input
            ref={input}
            type="file"
            accept="image/png"
            className="sr-only"
            aria-label={t("AgentEditorView.choose_avatar_file")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <div className="row">
            <button className="btn" onClick={() => input.current?.click()} disabled={busy}>{t("AgentEditorView.upload_png_avatar")}</button>
            {agent.hasAvatar ? (
              <button className="btn danger" onClick={() => setConfirmRemove(true)} disabled={busy}>{t("AgentEditorView.delete_avatar")}</button>
            ) : null}
          </div>
          <p className="small muted">{t("AgentEditorView.the_avatar_must_be_a_png_smaller_than_10_mib")}</p>
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmModal
          title={t("AgentEditorView.delete_avatar")}
          message={t("AgentEditorView.delete_this_agent_s_avatar")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
          danger
          busy={busy}
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            setBusy(true);
            endpoints
              .deleteAgentAvatar(agent.id)
              .then(async () => {
                const fresh = await endpoints.agent(agent.id);
                onChanged(fresh);
                await refreshAgents();
              })
              .catch(toastError)
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}

function ExecutionTab({ agent, mutate }: { agent: AgentDto; mutate: (fn: (draft: AgentDto) => void) => void }) {
  useLocale();
  const models = useStore(appStore, (s) => s.models);
  const execution = agent.execution;
  const generation = execution.generation ?? {};
  const selectedModel = models.find((model) => model.id === execution.modelId);
  const setExecution = (patch: Partial<AgentDto["execution"]>) =>
    mutate((draft) => {
      draft.execution = { ...draft.execution, ...patch };
    });
  const setGeneration = (patch: Partial<NonNullable<GenerationOverrides["common"]>>) =>
    mutate((draft) => {
      draft.execution.generation = {
        ...draft.execution.generation,
        common: { ...(draft.execution.generation?.common ?? {}), ...patch }
      };
    });

  return (
    <div>
      <div className="card">
        <EnvironmentSettings value={execution.environment} onChange={environment => setExecution({ environment })} />
        <h3>{t("AgentEditorView.model_and_reasoning")}</h3>
        <Field label={t("InspectorPanel.model")} hint={t("AgentEditorView.when_blank_new_conversations_use_the_most_recently_selected_model")}>
          <select
            className="select"
            aria-label={t("InspectorPanel.model")}
            value={execution.modelId ?? ""}
            onChange={(event) => setExecution({ modelId: event.target.value || null })}
          >
            <option value="">{t("AgentEditorView.no_default_model")}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.enabled}>
                {model.displayName}（{model.modelKey}）
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("AgentEditorView.fallback_vision_model")} hint={t("AgentEditorView.when_the_main_model_cannot_accept_images_this_model_creates")}>
          <select
            className="select"
            aria-label={t("AgentEditorView.fallback_vision_model")}
            value={execution.visionModelId ?? ""}
            onChange={(event) => setExecution({ visionModelId: event.target.value || null })}
          >
            <option value="">{t("AgentEditorView.not_configured")}</option>
            {models.filter((model) => model.enabled && model.capabilities.imageInput).map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}（{model.modelKey}）
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label={t("AgentEditorView.context_policy")}>
            <select
              className="select"
              aria-label={t("AgentEditorView.context_policy")}
              value={execution.contextPolicy}
              onChange={(event) => setExecution({ contextPolicy: event.target.value as ContextPolicy })}
            >
              {CONTEXT_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("ConnectionsView.reasoning_levels")}>
            <ReasoningSelect model={selectedModel} value={effectiveReasoningSelection(execution)}
              onChange={selection => { if (selection) setExecution({ reasoningSelection: selection, reasoningEffort: "none" }); }} />
          </Field>
        </div>
      </div>

      <div className="card">
        <h3>{t("AgentEditorView.generation_parameter_overrides")}</h3>
        <div className="grid-2">
          <Field label={t("ConnectionsView.temperature")} hint={t("AgentEditorView.0_2_leave_blank_to_use_the_model_default")}>
            <input
              className="input"
              type="number"
              step="0.1"
              min={0}
              max={2}
              aria-label={t("ConnectionsView.temperature")}
              value={generation.common?.temperature ?? ""}
              onChange={(event) =>
                setGeneration({ temperature: event.target.value === "" ? undefined : Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Top-P" hint="0 - 1。">
            <input
              className="input"
              type="number"
              step="0.05"
              min={0}
              max={1}
              aria-label="Top-P"
              value={generation.common?.topP ?? ""}
              onChange={(event) =>
                setGeneration({ topP: event.target.value === "" ? undefined : Number(event.target.value) })
              }
            />
          </Field>
        </div>
        <Field label={t("ConnectionsView.maximum_output_tokens")}>
          <input
            className="input"
            type="number"
            min={1}
            aria-label={t("ConnectionsView.maximum_output_tokens")}
            value={generation.common?.maxOutputTokens ?? ""}
            onChange={(event) =>
              setGeneration({ maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value) })
            }
          />
        </Field>
        <Field label={t("AgentEditorView.stop_sequences")} hint={t("AgentEditorView.one_per_line_up_to_8")}>
          <textarea
            className="textarea"
            aria-label={t("AgentEditorView.stop_sequences")}
            value={(generation.common?.stopSequences ?? []).join("\n")}
            onChange={(event) =>
              setGeneration({
                stopSequences: event.target.value === "" ? [] : event.target.value.split("\n").filter(Boolean)
              })
            }
          />
        </Field>
      </div>

      <div className="card">
        <h3>{t("AgentEditorView.execution_limits")}</h3>
        <div className="grid-2">
          <Field label={t("AgentEditorView.maximum_tool_rounds")}>
            <input
              className="input"
              type="number"
              min={1}
              aria-label={t("AgentEditorView.maximum_tool_rounds")}
              value={execution.maxToolRounds ?? ""}
              onChange={(event) =>
                setExecution({ maxToolRounds: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </Field>
          <Field label={t("AgentEditorView.maximum_background_tasks")}>
            <input
              className="input"
              type="number"
              min={0}
              aria-label={t("AgentEditorView.maximum_background_tasks")}
              value={execution.maxBackgroundTasks ?? ""}
              onChange={(event) =>
                setExecution({ maxBackgroundTasks: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </Field>
        </div>
        <Field label={t("AgentEditorView.task_log_limit_bytes")}>
          <input
            className="input"
            type="number"
            min={1}
            aria-label={t("AgentEditorView.task_log_limit")}
            value={execution.taskLogLimitBytes ?? ""}
            onChange={(event) =>
              setExecution({ taskLogLimitBytes: event.target.value === "" ? null : Number(event.target.value) })
            }
          />
        </Field>
      </div>
    </div>
  );
}

function ToolsTab({
  agent,
  mutate,
  catalog
}: {
  agent: AgentDto;
  mutate: (fn: (draft: AgentDto) => void) => void;
  catalog: ToolCatalogItemDto[];
}) {
  useLocale();
  const tools = agent.execution.tools;

  const setTools = (patch: Partial<ToolPolicy>) =>
    mutate((draft) => {
      draft.execution.tools = { ...draft.execution.tools, ...patch };
    });

  const setOverride = (key: "overrides" | "directOverrides", name: string, value: boolean | null) => {
    mutate((draft) => {
      const policy = draft.execution.tools;
      const next = { ...(policy[key] ?? {}) };
      if (value === null) delete next[name];
      else next[name] = value;
      (policy as Record<string, unknown>)[key] = next;
    });
  };

  const setApproval = (name: string, value: ApprovalPolicy | null) => {
    mutate((draft) => {
      const next = { ...draft.execution.tools.approvalOverrides };
      if (value === null) delete next[name];
      else next[name] = value;
      draft.execution.tools.approvalOverrides = next;
    });
  };

  return (
    <div>
      <p className="hint">{t("AgentEditorView.configure_search_engines_and_image_models_in_global_settings_manage")}</p>

      <div className="card">
        <h3>{t("AgentEditorView.tool_policy")}</h3>
      <Switch
        label={t("AgentEditorView.enable_all_tools_by_default")}
        checked={tools.defaultEnabled}
        onChange={(checked) => setTools({ defaultEnabled: checked })}
      />
      <table className="table agent-policy-table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>{t("SettingsView.tools")}</th>
            <th>{t("SettingsView.enable")}</th>
            <th>{t("AgentEditorView.direct")}</th>
            <th>{t("SettingsView.approval")}</th>
          </tr>
        </thead>
        <tbody>
          {catalog.filter(tool => agent.execution.environment?.type !== "container" || tool.name !== "workspace_shell_readonly").map((tool) => {
            const enabled = tools.overrides[tool.name];
            const direct = tools.directOverrides?.[tool.name];
            const approval = tools.approvalOverrides[tool.name];
            return (
              <tr key={tool.name}>
                <td>
                  <div>{toolLabel(tool)}</div>
                  <div className="small muted mono">{tool.name}</div>
                  {tool.name === "browser_fetch" ? <div className="small muted">{t("AgentEditorView.disabled_by_default_enable_explicitly", { value1: (toolError(tool) ?? "") })}</div> : null}
                  {tool.name === "workspace_shell_readonly" ? <div className="small muted">{t("AgentEditorView.read_only_no_network_no_approval_by_default", { value1: (!tool.available ? toolError(tool) ?? t("detail.runtime_unavailable") : "") })}</div> : null}
                </td>
                <td data-label={t("SettingsView.enable")}>
                  <PolicySelector
                    label={t("AgentEditorView.enablement_policy", { value1: (toolLabel(tool)) })}
                    value={enabled === undefined ? "default" : enabled ? "on" : "off"}
                    options={[["default", t("AgentEditorView.default")], ["on", t("SettingsView.enable")], ["off", t("AgentEditorView.disable")]]}
                    onChange={(value) => {
                      setOverride("overrides", tool.name, value === "default" ? null : value === "on");
                    }}
                  />
                </td>
                <td data-label={t("AgentEditorView.availability_mode")}>
                  <PolicySelector
                    label={t("AgentEditorView.availability_mode_2", { value1: (toolLabel(tool)) })}
                    value={direct === undefined ? "default" : direct ? "direct" : "lazy"}
                    options={[["default", t("AgentEditorView.default")], ["direct", t("AgentEditorView.direct")], ["lazy", t("AgentEditorView.lazy")]]}
                    onChange={(value) => {
                      setOverride("directOverrides", tool.name, value === "default" ? null : value === "direct");
                    }}
                  />
                </td>
                <td data-label={t("SettingsView.approval")}>
                  {agent.execution.environment?.type === "container" && tool.sourceKind === "builtin" && /^(workspace_|background_)/.test(tool.name) ? <span>{t("environment.automatic")}</span> : <PolicySelector
                    label={t("AgentEditorView.approval_policy", { value1: (toolLabel(tool)) })}
                    value={approval ?? "default"}
                    options={[["default", t("AgentEditorView.default")], ["always", t("AgentEditorView.always")], ["never", t("AgentEditorView.never")]]}
                    onChange={(value) => {
                      setApproval(tool.name, value === "default" ? null : value);
                    }}
                  />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function PolicySelector<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  useLocale();
  return (
    <div className="policy-segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          type="button"
          key={option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >{text}</button>
      ))}
    </div>
  );
}

function SkillsTab({
  agent,
  mutate,
  skills
}: {
  agent: AgentDto;
  mutate: (fn: (draft: AgentDto) => void) => void;
  skills: SkillDto[];
}) {
  useLocale();
  const enabled = new Set(agent.execution.enabledSkillIds);
  return (
    <div className="card">
      <h3>{t("AgentEditorView.enabled_skills")}</h3>
      {skills.length === 0 ? (
        <EmptyState title={t("AgentEditorView.no_available_skills")} hint={t("AgentEditorView.install_or_discover_skills_in_settings")} />
      ) : (
        <div className="agent-skill-list">
          {skills.map((skill) => (
            <div key={skill.id} className="agent-skill-row">
              <div className="agent-skill-copy">
                <strong>{skillName(skill)}</strong>
                <span>{skillDescription(skill) || t("SettingsView.no_description")}</span>
              </div>
              <Switch
                label={t("ConnectionsView.enable", { value1: (skillName(skill)) })}
                hideLabel
                checked={enabled.has(skill.id)}
                disabled={skill.state === "error" || skill.state === "unloaded"}
                onChange={(checked) => {
                mutate((draft) => {
                  const next = new Set(draft.execution.enabledSkillIds);
                  if (checked) next.add(skill.id);
                  else next.delete(skill.id);
                  draft.execution.enabledSkillIds = [...next];
                });
              }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UserProfileTab({ agent, mutate }: { agent: AgentDto; mutate: (fn: (draft: AgentDto) => void) => void }) {
  useLocale();
  return (
    <div className="card">
      <h3>{t("AgentEditorView.user_profile_overrides")}</h3>
      <p className="small muted">{t("AgentEditorView.leave_blank_to_use_the_global_user_profile")}</p>
      <Field label={t("SettingsView.user_display_name")}>
        <input
          className="input"
          aria-label={t("SettingsView.user_display_name")}
          value={agent.userProfile.displayName ?? ""}
          onChange={(event) =>
            mutate((draft) => {
              draft.userProfile = {
                ...draft.userProfile,
                displayName: event.target.value === "" ? undefined : event.target.value
              };
            })
          }
        />
      </Field>
      <Field label={t("SettingsView.user_description")}>
        <ExpandableTextarea
          label={t("SettingsView.user_description")}
          value={agent.userProfile.description ?? ""}
          onChange={(value) =>
            mutate((draft) => {
              draft.userProfile = {
                ...draft.userProfile,
                description: value === "" ? undefined : value
              };
            })
          }
        />
      </Field>
    </div>
  );
}
