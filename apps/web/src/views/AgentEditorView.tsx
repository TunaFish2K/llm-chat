import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type {
  AgentDto,
  ApprovalPolicy,
  CharacterBook,
  ContextPolicy,
  GenerationOverrides,
  ReasoningEffort,
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

const REASONING_LEVELS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const CONTEXT_POLICIES: ContextPolicy[] = ["auto", "trim", "summarize", "full"];
const TABS = [
  ["card", "角色卡"],
  ["roleplay", "角色扮演"],
  ["avatar", "头像"],
  ["execution", "执行配置"],
  ["tools", "工具"],
  ["skills", "Skill"],
  ["user", "用户画像"]
] as const;
type Tab = (typeof TABS)[number][0];

export function AgentEditorView({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("card");
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setError(null);
    setDirty(false);
    Promise.all([endpoints.agent(agentId), endpoints.toolCatalog(), endpoints.skills()])
      .then(([agentData, catalogData, skillData]) => {
        if (cancelled) return;
        setAgent(agentData);
        setCatalog(catalogData);
        setSkills(skillData);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "加载 Agent 失败");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const resource = (event as CustomEvent<{ resource?: string }>).detail?.resource;
      if (resource === "agents" && !dirty) void endpoints.agent(agentId).then(setAgent).catch(toastError);
      if (resource === "tools") void endpoints.toolCatalog().then(setCatalog).catch(toastError);
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
      toast("success", "已保存 Agent");
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
        <LoadingState label="加载 Agent…" />
      </div>
    );
  }

  return (
    <>
      <div className="page-header mobile-redundant-title">
        <h2>
          {agent.name}
          {agent.protected ? <span className="tag accent" style={{ marginLeft: 8 }}>内置</span> : null}
        </h2>
        <div className="actions">
          <button className="btn" onClick={() => navigate(routes.agents())}>
            返回列表
          </button>
          <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "保存中…" : dirty ? "保存修改" : "已保存"}
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
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
          {tab === "tools" ? <ToolsTab agent={agent} mutate={mutate} catalog={catalog} /> : null}
          {tab === "skills" ? <SkillsTab agent={agent} mutate={mutate} skills={skills} /> : null}
          {tab === "user" ? <UserProfileTab agent={agent} mutate={mutate} /> : null}
        </div>
      </div>
    </>
  );
}

function CardTab({ agent, mutate }: { agent: AgentDto; mutate: (fn: (draft: AgentDto) => void) => void }) {
  const data = agent.card.data;
  const setField = (key: string, value: unknown) =>
    mutate((draft) => {
      (draft.card.data as unknown as Record<string, unknown>)[key] = value;
    });
  const [bookJson, setBookJson] = useState(() => JSON.stringify(data.character_book ?? null, null, 2));
  const [bookError, setBookError] = useState<string | null>(null);

  return (
    <div>
      <Field label="名称" htmlFor="agent-name">
        <input
          id="agent-name"
          className="input"
          value={data.name}
          onChange={(event) => setField("name", event.target.value)}
        />
      </Field>
      <Field label="描述">
        <ExpandableTextarea
          label="角色描述"
          value={data.description}
          onChange={(value) => setField("description", value)}
        />
      </Field>
      <div className="grid-2">
        <Field label="性格">
          <ExpandableTextarea
            label="角色性格"
            value={data.personality}
            onChange={(value) => setField("personality", value)}
          />
        </Field>
        <Field label="场景">
          <ExpandableTextarea
            label="角色场景"
            value={data.scenario}
            onChange={(value) => setField("scenario", value)}
          />
        </Field>
      </div>
      <Field label="开场白">
        <ExpandableTextarea
          label="开场白"
          value={data.first_mes}
          onChange={(value) => setField("first_mes", value)}
        />
      </Field>
      <div className="field greeting-editor">
        <div className="field-heading">
          <div>
            <label>备选开场白</label>
            <span className="hint">每条可包含多行；新会话中可预览和切换。</span>
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() => setField("alternate_greetings", [...data.alternate_greetings, ""])}
          >
            <Plus size={15} aria-hidden="true" />新增
          </button>
        </div>
        {data.alternate_greetings.length === 0 ? (
          <p className="small muted">尚未添加备选开场白。</p>
        ) : (
          <div className="greeting-editor-list">
            {data.alternate_greetings.map((greeting, index) => (
              <div className="greeting-editor-item" key={index}>
                <div className="greeting-editor-item-header">
                  <span>备选 {index + 1}</span>
                  <div className="row compact">
                    <button
                      type="button"
                      className="btn ghost icon"
                      title="上移"
                      aria-label={`上移备选开场白 ${index + 1}`}
                      disabled={index === 0}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.map((item, itemIndex) =>
                        itemIndex === index - 1 ? greeting : itemIndex === index ? data.alternate_greetings[index - 1] : item
                      ))}
                    ><ArrowUp size={15} /></button>
                    <button
                      type="button"
                      className="btn ghost icon"
                      title="下移"
                      aria-label={`下移备选开场白 ${index + 1}`}
                      disabled={index === data.alternate_greetings.length - 1}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.map((item, itemIndex) =>
                        itemIndex === index + 1 ? greeting : itemIndex === index ? data.alternate_greetings[index + 1] : item
                      ))}
                    ><ArrowDown size={15} /></button>
                    <button
                      type="button"
                      className="btn ghost icon danger"
                      title="删除"
                      aria-label={`删除备选开场白 ${index + 1}`}
                      onClick={() => setField("alternate_greetings", data.alternate_greetings.filter((_, itemIndex) => itemIndex !== index))}
                    ><Trash2 size={15} /></button>
                  </div>
                </div>
                <ExpandableTextarea
                  label={`备选开场白 ${index + 1}`}
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
      <Field label="对话示例">
        <ExpandableTextarea
          label="对话示例"
          value={data.mes_example}
          onChange={(value) => setField("mes_example", value)}
        />
      </Field>
      <Field label="系统提示">
        <ExpandableTextarea
          label="系统提示"
          value={data.system_prompt}
          onChange={(value) => setField("system_prompt", value)}
        />
      </Field>
      <Field label="历史后指令">
        <ExpandableTextarea
          label="历史后指令"
          value={data.post_history_instructions}
          onChange={(value) => setField("post_history_instructions", value)}
        />
      </Field>
      <Field label="创作者备注">
        <ExpandableTextarea
          label="创作者备注"
          value={data.creator_notes}
          onChange={(value) => setField("creator_notes", value)}
        />
      </Field>
      <div className="grid-2">
        <Field label="标签" hint="逗号分隔">
          <input
            className="input"
            aria-label="标签"
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
        <Field label="创作者">
          <input
            className="input"
            aria-label="创作者"
            value={data.creator}
            onChange={(event) => setField("creator", event.target.value)}
          />
        </Field>
      </div>
      <Field label="角色版本">
        <input
          className="input"
          aria-label="角色版本"
          value={data.character_version}
          onChange={(event) => setField("character_version", event.target.value)}
        />
      </Field>
      <Field label="世界书（Character Book，JSON）" hint="保持 null 表示不使用。">
        <ExpandableTextarea
          label="世界书 JSON"
          mono
          value={bookJson}
          onChange={(value) => {
            setBookJson(value);
            try {
              const parsed = JSON.parse(value) as CharacterBook | null;
              setBookError(null);
              setField("character_book", parsed ?? undefined);
            } catch {
              setBookError("JSON 无法解析，保存前请修正");
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
      toast("success", "头像已更新");
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>头像</h3>
      <div className="row">
        {agent.hasAvatar ? (
          <img
            className="avatar-img"
            style={{ width: 96, height: 96 }}
            src={`/api/agents/${agent.id}/avatar?t=${agent.updatedAt}`}
            alt={`${agent.name} 的头像`}
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
            aria-label="选择头像文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <div className="row">
            <button className="btn" onClick={() => input.current?.click()} disabled={busy}>
              上传 PNG 头像
            </button>
            {agent.hasAvatar ? (
              <button className="btn danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
                删除头像
              </button>
            ) : null}
          </div>
          <p className="small muted">头像必须是小于 10 MiB 的 PNG。</p>
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmModal
          title="删除头像"
          message="确定删除该 Agent 的头像吗？"
          confirmLabel="删除"
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
  const models = useStore(appStore, (s) => s.models);
  const execution = agent.execution;
  const generation = execution.generation ?? {};
  const selectedModel = models.find((model) => model.id === execution.modelId);
  const advertisedReasoning = selectedModel?.catalogMetadata?.reasoningEfforts ?? [];
  const reasoningLevels = advertisedReasoning.length > 0
    ? [...new Set([...advertisedReasoning, execution.reasoningEffort])]
    : REASONING_LEVELS;

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
        <h3>模型与推理</h3>
        <Field label="模型" hint="留空使用应用默认模型。">
          <select
            className="select"
            aria-label="模型"
            value={execution.modelId ?? ""}
            onChange={(event) => setExecution({ modelId: event.target.value || null })}
          >
            <option value="">（应用默认）</option>
            {models.map((model) => (
              <option key={model.id} value={model.id} disabled={!model.enabled}>
                {model.displayName}（{model.modelKey}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="备用识图模型" hint="主模型不支持图片时，先用此模型生成可审计的图片说明。">
          <select
            className="select"
            aria-label="备用识图模型"
            value={execution.visionModelId ?? ""}
            onChange={(event) => setExecution({ visionModelId: event.target.value || null })}
          >
            <option value="">（未配置）</option>
            {models.filter((model) => model.enabled && model.capabilities.imageInput).map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}（{model.modelKey}）
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="上下文策略">
            <select
              className="select"
              aria-label="上下文策略"
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
          <Field label="推理档位">
            <select
              className="select"
              aria-label="推理档位"
              value={execution.reasoningEffort}
              onChange={(event) => setExecution({ reasoningEffort: event.target.value as ReasoningEffort })}
            >
              {reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="card">
        <h3>生成参数覆盖</h3>
        <div className="grid-2">
          <Field label="温度" hint="0 - 2，留空使用模型默认。">
            <input
              className="input"
              type="number"
              step="0.1"
              min={0}
              max={2}
              aria-label="温度"
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
        <Field label="最大输出 token">
          <input
            className="input"
            type="number"
            min={1}
            aria-label="最大输出 token"
            value={generation.common?.maxOutputTokens ?? ""}
            onChange={(event) =>
              setGeneration({ maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value) })
            }
          />
        </Field>
        <Field label="停止序列" hint="每行一个，最多 8 个。">
          <textarea
            className="textarea"
            aria-label="停止序列"
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
        <h3>执行上限</h3>
        <div className="grid-2">
          <Field label="最大工具轮数">
            <input
              className="input"
              type="number"
              min={1}
              aria-label="最大工具轮数"
              value={execution.maxToolRounds ?? ""}
              onChange={(event) =>
                setExecution({ maxToolRounds: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </Field>
          <Field label="最大后台任务数">
            <input
              className="input"
              type="number"
              min={0}
              aria-label="最大后台任务数"
              value={execution.maxBackgroundTasks ?? ""}
              onChange={(event) =>
                setExecution({ maxBackgroundTasks: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </Field>
        </div>
        <Field label="任务日志上限（字节）">
          <input
            className="input"
            type="number"
            min={1}
            aria-label="任务日志上限"
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
    <div className="card">
      <h3>工具策略</h3>
      <Switch
        label="默认启用所有工具"
        checked={tools.defaultEnabled}
        onChange={(checked) => setTools({ defaultEnabled: checked })}
      />
      <table className="table agent-policy-table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>工具</th>
            <th>启用</th>
            <th>直接</th>
            <th>审批</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((tool) => {
            const enabled = tools.overrides[tool.name];
            const direct = tools.directOverrides?.[tool.name];
            const approval = tools.approvalOverrides[tool.name];
            return (
              <tr key={tool.name}>
                <td>
                  <div>{tool.label}</div>
                  <div className="small muted mono">{tool.name}</div>
                </td>
                <td data-label="启用">
                  <PolicySelector
                    label={`${tool.label} 启用策略`}
                    value={enabled === undefined ? "default" : enabled ? "on" : "off"}
                    options={[["default", "默认"], ["on", "启用"], ["off", "停用"]]}
                    onChange={(value) => {
                      setOverride("overrides", tool.name, value === "default" ? null : value === "on");
                    }}
                  />
                </td>
                <td data-label="直接性">
                  <PolicySelector
                    label={`${tool.label} 直接性`}
                    value={direct === undefined ? "default" : direct ? "direct" : "lazy"}
                    options={[["default", "默认"], ["direct", "直接"], ["lazy", "惰性"]]}
                    onChange={(value) => {
                      setOverride("directOverrides", tool.name, value === "default" ? null : value === "direct");
                    }}
                  />
                </td>
                <td data-label="审批">
                  <PolicySelector
                    label={`${tool.label} 审批策略`}
                    value={approval ?? "default"}
                    options={[["default", "默认"], ["always", "每次"], ["never", "免审"]]}
                    onChange={(value) => {
                      setApproval(tool.name, value === "default" ? null : value);
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
  const enabled = new Set(agent.execution.enabledSkillIds);
  return (
    <div className="card">
      <h3>启用的 Skill</h3>
      {skills.length === 0 ? (
        <EmptyState title="没有可用 Skill" hint="在设置中安装或发现 Skill。" />
      ) : (
        <div className="agent-skill-list">
          {skills.map((skill) => (
            <div key={skill.id} className="agent-skill-row">
              <div className="agent-skill-copy">
                <strong>{skill.name}</strong>
                <span>{skill.description || "无描述"}</span>
              </div>
              <Switch
                label={`启用 ${skill.name}`}
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
  return (
    <div className="card">
      <h3>用户画像覆盖</h3>
      <p className="small muted">留空时使用全局用户画像。</p>
      <Field label="用户显示名">
        <input
          className="input"
          aria-label="用户显示名"
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
      <Field label="用户描述">
        <ExpandableTextarea
          label="用户描述"
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
