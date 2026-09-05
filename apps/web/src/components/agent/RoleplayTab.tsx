import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, Upload } from "lucide-react";
import type {
  AgentDto,
  AgentRoleplayConfig,
  RoleplayGenerationTrigger,
  RoleplayPreset,
  RoleplayPromptBlock
} from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { refreshAgents, toast, toastError } from "../../lib/app-state";
import { fileToBase64 } from "../../lib/format";
import { EmptyState, Field, Switch } from "../../lib/ui";
import { ExpandableTextarea } from "../ExpandableTextarea";

const BLOCK_KINDS: Array<[RoleplayPromptBlock["kind"], string]> = [
  ["main", "主提示"], ["lore_before", "世界信息（角色前）"], ["character", "角色定义"],
  ["lore_after", "世界信息（角色后）"], ["persona", "用户身份"], ["examples", "对话示例"],
  ["history", "聊天记录"], ["author_note", "作者注释"], ["post_history", "历史后指令"], ["custom", "自定义"]
];
const TRIGGERS: Array<[RoleplayGenerationTrigger, string]> = [
  ["normal", "普通"], ["continue", "继续"], ["regenerate", "重新生成"], ["script", "脚本"]
];

export function RoleplayTab({
  agent,
  mutate,
  onReplace
}: {
  agent: AgentDto;
  mutate: (fn: (draft: AgentDto) => void) => void;
  onReplace: (agent: AgentDto) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const config = agent.roleplay;
  const activeId = config.defaultPresetId ?? config.presets[0]?.id ?? null;
  const preset = config.presets.find((item) => item.id === activeId) ?? config.presets[0];
  const setConfig = (patch: Partial<AgentRoleplayConfig>) => mutate((draft) => {
    draft.roleplay = { ...draft.roleplay, ...patch };
  });
  const updatePreset = (fn: (value: RoleplayPreset) => RoleplayPreset) => {
    if (!preset) return;
    setConfig({ presets: config.presets.map((item) => item.id === preset.id ? fn(item) : item) });
  };

  const importPreset = async (file: File) => {
    setBusy(true);
    try {
      await endpoints.updateAgent(agent.id, {
        card: agent.card,
        execution: agent.execution,
        userProfile: agent.userProfile,
        roleplay: agent.roleplay
      });
      const updated = await endpoints.importRoleplayPreset(agent.id, file.name, await fileToBase64(file));
      onReplace(updated);
      await refreshAgents();
      toast("success", "预设已导入并保存");
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card roleplay-mode-card">
        <div className="roleplay-mode-heading">
          <div>
            <h3>角色扮演工作流</h3>
            <p className="small muted">预设、人物、世界书和脚本只属于当前 Agent。关闭后使用普通聊天链路。</p>
          </div>
          <Switch label="启用角色扮演" checked={config.enabled} onChange={(enabled) => setConfig({ enabled })} />
        </div>
      </div>

      <div className="card">
        <div className="field-heading roleplay-preset-heading">
          <div>
            <h3>提示预设</h3>
            <p className="small muted">支持原生预设和常见 SillyTavern JSON 预设。</p>
          </div>
          <div className="row compact">
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              aria-label="导入 SillyTavern 预设"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importPreset(file);
              }}
            />
            <button className="btn small" disabled={busy} onClick={() => input.current?.click()}>
              <Upload size={15} aria-hidden="true" />导入
            </button>
            <button className="btn small" disabled={!preset} onClick={() => preset && duplicatePreset(config, preset, setConfig)}>
              <Copy size={15} aria-hidden="true" />复制
            </button>
            <button
              className="btn small danger"
              disabled={!preset || config.presets.length <= 1}
              onClick={() => {
                if (!preset) return;
                const presets = config.presets.filter((item) => item.id !== preset.id);
                setConfig({ presets, defaultPresetId: presets[0]?.id ?? null });
              }}
            >
              <Trash2 size={15} aria-hidden="true" />删除
            </button>
          </div>
        </div>

        <Field label="当前默认预设">
          <select className="select" value={activeId ?? ""} onChange={(event) => setConfig({ defaultPresetId: event.target.value })}>
            {config.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>

        {preset ? (
          <PresetEditor preset={preset} updatePreset={updatePreset} />
        ) : (
          <EmptyState title="没有预设" hint="重新加载 Agent 后会自动创建默认预设。" />
        )}
      </div>
    </div>
  );
}

function PresetEditor({
  preset,
  updatePreset
}: {
  preset: RoleplayPreset;
  updatePreset: (fn: (value: RoleplayPreset) => RoleplayPreset) => void;
}) {
  const updateBlock = (id: string, patch: Partial<RoleplayPromptBlock>) => updatePreset((value) => ({
    ...value,
    blocks: value.blocks.map((block) => block.id === id ? { ...block, ...patch } : block)
  }));
  const moveBlock = (index: number, direction: -1 | 1) => updatePreset((value) => {
    const blocks = [...value.blocks];
    const target = index + direction;
    if (!blocks[index] || !blocks[target]) return value;
    [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
    return { ...value, blocks: blocks.map((block, order) => ({ ...block, order })) };
  });
  const updateGeneration = (patch: Record<string, number | undefined>) => updatePreset((value) => ({
    ...value,
    generation: { ...value.generation, common: { ...(value.generation.common ?? {}), ...patch } }
  }));

  return (
    <>
      <Field label="预设名称">
        <input className="input" value={preset.name} onChange={(event) => updatePreset((value) => ({ ...value, name: event.target.value }))} />
      </Field>
      {preset.importWarnings.length ? (
        <div className="notice warning" role="status">
          {preset.importWarnings.map((warning, index) => <div key={index}>{warning}</div>)}
        </div>
      ) : null}
      <div className="grid-3 roleplay-generation-grid">
        <GenerationNumber label="预设温度" min={0} max={2} step={0.1} value={preset.generation.common?.temperature} onChange={(value) => updateGeneration({ temperature: value })} />
        <GenerationNumber label="预设 Top-P" min={0} max={1} step={0.05} value={preset.generation.common?.topP} onChange={(value) => updateGeneration({ topP: value })} />
        <GenerationNumber label="预设输出上限" min={1} value={preset.generation.common?.maxOutputTokens} onChange={(value) => updateGeneration({ maxOutputTokens: value })} />
      </div>
      <div className="roleplay-block-list">
        {preset.blocks.map((block, index) => (
          <div className="roleplay-block" key={block.id}>
            <div className="roleplay-block-heading">
              <Switch label={block.name} checked={block.enabled} onChange={(enabled) => updateBlock(block.id, { enabled })} />
              <div className="row compact">
                <button className="btn ghost icon" aria-label={`上移 ${block.name}`} disabled={index === 0} onClick={() => moveBlock(index, -1)}><ArrowUp size={15} /></button>
                <button className="btn ghost icon" aria-label={`下移 ${block.name}`} disabled={index === preset.blocks.length - 1} onClick={() => moveBlock(index, 1)}><ArrowDown size={15} /></button>
                <button
                  className="btn ghost icon danger"
                  aria-label={`删除 ${block.name}`}
                  disabled={block.kind === "history" && preset.blocks.filter((item) => item.kind === "history").length === 1}
                  onClick={() => updatePreset((value) => ({
                    ...value,
                    blocks: value.blocks.filter((item) => item.id !== block.id).map((item, order) => ({ ...item, order }))
                  }))}
                ><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="roleplay-block-controls">
              <input className="input" aria-label={`${block.name} 名称`} value={block.name} onChange={(event) => updateBlock(block.id, { name: event.target.value })} />
              <select className="select" aria-label={`${block.name} 类型`} value={block.kind} onChange={(event) => updateBlock(block.id, { kind: event.target.value as RoleplayPromptBlock["kind"] })}>
                {BLOCK_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="select" aria-label={`${block.name} 角色`} value={block.role} onChange={(event) => updateBlock(block.id, { role: event.target.value as RoleplayPromptBlock["role"] })}>
                <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
              </select>
              <select className="select" aria-label={`${block.name} 位置`} value={block.position} onChange={(event) => updateBlock(block.id, { position: event.target.value as RoleplayPromptBlock["position"] })}>
                <option value="relative">相对顺序</option><option value="in_chat">聊天内注入</option>
              </select>
              {block.position === "in_chat" ? (
                <input className="input" type="number" min={0} aria-label={`${block.name} 注入深度`} value={block.depth} onChange={(event) => updateBlock(block.id, { depth: Number(event.target.value) })} />
              ) : null}
            </div>
            <div className="roleplay-trigger-row" aria-label={`${block.name} 生效场景`}>
              {TRIGGERS.map(([trigger, label]) => (
                <label className="check-row" key={trigger}>
                  <input
                    type="checkbox"
                    checked={block.triggers.includes(trigger)}
                    onChange={(event) => updateBlock(block.id, {
                      triggers: event.target.checked
                        ? [...new Set([...block.triggers, trigger])]
                        : block.triggers.filter((item) => item !== trigger)
                    })}
                  />
                  {label}
                </label>
              ))}
            </div>
            {block.kind === "history" ? (
              <p className="small muted">聊天记录在此位置插入。</p>
            ) : (
              <ExpandableTextarea label={`${block.name} 内容`} value={block.content} placeholder="留空时使用角色卡对应字段" onChange={(content) => updateBlock(block.id, { content })} />
            )}
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => updatePreset((value) => ({
        ...value,
        blocks: [...value.blocks, newBlock(value.blocks.length)]
      }))}>
        <Plus size={15} aria-hidden="true" />新增提示块
      </button>
    </>
  );
}

function GenerationNumber({ label, value, onChange, min, max, step }: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min: number;
  max?: number;
  step?: number;
}) {
  return <Field label={label}><input className="input" type="number" min={min} max={max} step={step} value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} /></Field>;
}

function duplicatePreset(
  config: AgentRoleplayConfig,
  preset: RoleplayPreset,
  setConfig: (patch: Partial<AgentRoleplayConfig>) => void
): void {
  const copy: RoleplayPreset = {
    ...JSON.parse(JSON.stringify(preset)) as RoleplayPreset,
    id: crypto.randomUUID(),
    name: `${preset.name} 副本`,
    importedFrom: "native",
    importWarnings: [],
    blocks: preset.blocks.map((block) => ({ ...block, id: crypto.randomUUID() }))
  };
  setConfig({ presets: [...config.presets, copy], defaultPresetId: copy.id });
}

function newBlock(order: number): RoleplayPromptBlock {
  return {
    id: crypto.randomUUID(), name: "自定义提示", kind: "custom", enabled: true,
    role: "system", position: "relative", depth: 0, order,
    triggers: ["normal", "continue", "regenerate", "script"], content: ""
  };
}
