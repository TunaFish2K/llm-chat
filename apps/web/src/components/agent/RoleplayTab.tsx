import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, File, Image, Plus, Trash2, Upload } from "lucide-react";
import type {
  AgentDto,
  AgentLorebook,
  AgentPersona,
  AgentQuickReplySet,
  AgentRegexScript,
  AgentRoleplayConfig,
  CharacterBookEntry,
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

      <PersonasEditor config={config} setConfig={setConfig} />
      <LorebooksEditor config={config} setConfig={setConfig} />
      <AssetsEditor agent={agent} config={config} onReplace={onReplace} />
      <RegexEditor config={config} setConfig={setConfig} />
      <QuickRepliesEditor config={config} setConfig={setConfig} />
    </div>
  );
}

function RegexEditor({ config, setConfig }: { config: AgentRoleplayConfig; setConfig: (patch: Partial<AgentRoleplayConfig>) => void }) {
  const update = (id: string, patch: Partial<AgentRegexScript>) => setConfig({
    regexScripts: config.regexScripts.map((script) => script.id === id ? { ...script, ...patch } : script)
  });
  const scopes: Array<[AgentRegexScript["scopes"][number], string]> = [
    ["user_prompt", "用户提示"], ["assistant_prompt", "助手历史"], ["world_info", "世界信息"], ["display", "显示"]
  ];
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>安全正则</h3><p className="small muted">使用 RE2 线性时间引擎。导入项默认关闭，不支持回溯引用与环视。</p></div>
        <button className="btn small" onClick={() => setConfig({ regexScripts: [...config.regexScripts, { id: crypto.randomUUID(), name: "新正则", enabled: false, pattern: "", replacement: "", flags: "gu", scopes: ["display"], runOnEdit: false, importWarning: null }] })}><Plus size={15} />新增</button>
      </div>
      {config.regexScripts.length ? <div className="roleplay-resource-list">{config.regexScripts.map((script) => (
        <details className="roleplay-resource" key={script.id}>
          <summary><Switch label={script.name} checked={script.enabled} onChange={(enabled) => update(script.id, { enabled })} /><span>{script.scopes.map((scope) => scopes.find(([id]) => id === scope)?.[1]).filter(Boolean).join(" · ")}</span></summary>
          <div className="roleplay-resource-body">
            {script.importWarning ? <div className="notice warning">{script.importWarning}</div> : null}
            <div className="grid-2"><Field label="名称"><input className="input" value={script.name} onChange={(event) => update(script.id, { name: event.target.value })} /></Field><Field label="标志"><input className="input" value={script.flags} onChange={(event) => update(script.id, { flags: event.target.value })} /></Field></div>
            <ExpandableTextarea label="匹配表达式" value={script.pattern} onChange={(pattern) => update(script.id, { pattern })} />
            <ExpandableTextarea label="替换内容" value={script.replacement} onChange={(replacement) => update(script.id, { replacement })} />
            <div className="roleplay-trigger-row">{scopes.map(([scope, label]) => <label className="check-row" key={scope}><input type="checkbox" checked={script.scopes.includes(scope)} onChange={(event) => update(script.id, { scopes: event.target.checked ? [...new Set([...script.scopes, scope])] : script.scopes.filter((item) => item !== scope) })} />{label}</label>)}</div>
            <button className="btn small danger" onClick={() => setConfig({ regexScripts: config.regexScripts.filter((item) => item.id !== script.id) })}><Trash2 size={15} />删除</button>
          </div>
        </details>
      ))}</div> : <p className="small muted">没有正则脚本。</p>}
    </section>
  );
}

function QuickRepliesEditor({ config, setConfig }: { config: AgentRoleplayConfig; setConfig: (patch: Partial<AgentRoleplayConfig>) => void }) {
  const updateSet = (id: string, fn: (set: AgentQuickReplySet) => AgentQuickReplySet) => setConfig({
    quickReplySets: config.quickReplySets.map((set) => set.id === id ? fn(set) : set)
  });
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>快捷回复与受限脚本</h3><p className="small muted">脚本只可修改当前角色会话的变量、预设、人物、世界书和输入草稿；不能执行 JS、Shell 或网络请求。</p></div>
        <button className="btn small" onClick={() => setConfig({ quickReplySets: [...config.quickReplySets, { id: crypto.randomUUID(), name: "新快捷组", enabled: true, replies: [] }] })}><Plus size={15} />新增组</button>
      </div>
      {config.quickReplySets.length ? <div className="roleplay-resource-list">{config.quickReplySets.map((set) => (
        <details className="roleplay-resource" key={set.id}>
          <summary><Switch label={set.name} checked={set.enabled} onChange={(enabled) => updateSet(set.id, (value) => ({ ...value, enabled }))} /><span>{set.replies.length} 项</span></summary>
          <div className="roleplay-resource-body">
            <Field label="组名"><input className="input" value={set.name} onChange={(event) => updateSet(set.id, (value) => ({ ...value, name: event.target.value }))} /></Field>
            <div className="roleplay-entry-list">{set.replies.map((reply, index) => (
              <details className="roleplay-entry" key={reply.id}>
                <summary><strong>{reply.label}</strong><span>{reply.mode === "insert" ? "插入" : reply.mode === "send" ? "发送" : "受限脚本"}</span></summary>
                <div className="roleplay-entry-body">
                  <div className="grid-3"><Field label="按钮文字"><input className="input" value={reply.label} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, label: event.target.value } : item) }))} /></Field><Field label="模式"><select className="select" value={reply.mode} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, mode: event.target.value as typeof reply.mode } : item) }))}><option value="insert">插入草稿</option><option value="send">立即发送</option><option value="script">受限 STscript</option></select></Field><Field label="提示"><input className="input" value={reply.tooltip} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, tooltip: event.target.value } : item) }))} /></Field></div>
                  <ExpandableTextarea label={reply.mode === "script" ? "脚本" : "内容"} value={reply.content} onChange={(content) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, content } : item) }))} />
                  <div className="roleplay-trigger-row"><label className="check-row"><input type="checkbox" checked={reply.enabled} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, enabled: event.target.checked } : item) }))} />启用</label><label className="check-row"><input type="checkbox" checked={reply.pinned} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, pinned: event.target.checked } : item) }))} />固定显示</label>{reply.mode === "script" ? (["new_chat", "before_send", "after_reply", "lore_activated"] as const).map((trigger) => <label className="check-row" key={trigger}><input type="checkbox" checked={reply.autoTriggers.includes(trigger)} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, autoTriggers: event.target.checked ? [...new Set([...item.autoTriggers, trigger])] : item.autoTriggers.filter((value) => value !== trigger) } : item) }))} />{trigger}</label>) : null}</div>
                  <button className="btn small danger" onClick={() => updateSet(set.id, (value) => ({ ...value, replies: value.replies.filter((_, current) => current !== index) }))}><Trash2 size={15} />删除</button>
                </div>
              </details>
            ))}</div>
            <div className="row compact"><button className="btn small" onClick={() => updateSet(set.id, (value) => ({ ...value, replies: [...value.replies, { id: crypto.randomUUID(), label: "新快捷回复", tooltip: "", mode: "insert", content: "", enabled: true, pinned: false, autoTriggers: [] }] }))}><Plus size={15} />新增快捷回复</button><button className="btn small danger" onClick={() => setConfig({ quickReplySets: config.quickReplySets.filter((item) => item.id !== set.id) })}><Trash2 size={15} />删除组</button></div>
          </div>
        </details>
      ))}</div> : <p className="small muted">没有快捷回复。</p>}
    </section>
  );
}

function PersonasEditor({ config, setConfig }: {
  config: AgentRoleplayConfig;
  setConfig: (patch: Partial<AgentRoleplayConfig>) => void;
}) {
  const update = (id: string, patch: Partial<AgentPersona>) => setConfig({
    personas: config.personas.map((item) => item.id === id ? { ...item, ...patch } : item)
  });
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>人物身份</h3><p className="small muted">仅在当前 Agent 的角色扮演会话中替代全局用户资料。</p></div>
        <button className="btn small" onClick={() => {
          const persona: AgentPersona = { id: crypto.randomUUID(), name: "新人物", description: "", avatarAssetId: null };
          setConfig({ personas: [...config.personas, persona], defaultPersonaId: config.defaultPersonaId ?? persona.id });
        }}><Plus size={15} />新增</button>
      </div>
      {config.personas.length ? <div className="roleplay-resource-list">{config.personas.map((persona) => (
        <details className="roleplay-resource" key={persona.id}>
          <summary><strong>{persona.name}</strong>{config.defaultPersonaId === persona.id ? <span className="tag accent">默认</span> : null}</summary>
          <div className="roleplay-resource-body">
            <Field label="名称"><input className="input" aria-label={`人物名称 ${persona.name}`} value={persona.name} onChange={(event) => update(persona.id, { name: event.target.value })} /></Field>
            <ExpandableTextarea label="人物描述" value={persona.description} onChange={(description) => update(persona.id, { description })} />
            <Field label="人物头像素材">
              <select className="select" value={persona.avatarAssetId ?? ""} onChange={(event) => update(persona.id, { avatarAssetId: event.target.value || null })}>
                <option value="">不使用</option>
                {config.assets.filter((asset) => asset.mimeType?.startsWith("image/")).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </Field>
            <div className="row compact">
              <button className="btn small" onClick={() => setConfig({ defaultPersonaId: persona.id })}>设为默认</button>
              <button className="btn small danger" onClick={() => setConfig({
                personas: config.personas.filter((item) => item.id !== persona.id),
                defaultPersonaId: config.defaultPersonaId === persona.id ? null : config.defaultPersonaId
              })}><Trash2 size={15} />删除</button>
            </div>
          </div>
        </details>
      ))}</div> : <p className="small muted">未配置人物身份时继续使用 Agent 或全局用户资料。</p>}
    </section>
  );
}

function LorebooksEditor({ config, setConfig }: {
  config: AgentRoleplayConfig;
  setConfig: (patch: Partial<AgentRoleplayConfig>) => void;
}) {
  const updateBook = (id: string, fn: (book: AgentLorebook) => AgentLorebook) => setConfig({
    lorebooks: config.lorebooks.map((book) => book.id === id ? fn(book) : book)
  });
  const updateEntry = (book: AgentLorebook, index: number, patch: Partial<CharacterBookEntry>) => updateBook(book.id, (value) => ({
    ...value, book: { ...value.book, entries: value.book.entries.map((entry, current) => current === index ? { ...entry, ...patch } : entry) }
  }));
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>附加世界书</h3><p className="small muted">按关键词和预算注入；角色卡内置世界书仍然保留。</p></div>
        <button className="btn small" onClick={() => {
          const book: AgentLorebook = {
            id: crypto.randomUUID(), name: "新世界书", enabled: true,
            book: { name: "新世界书", description: "", scan_depth: 4, recursive_scanning: false, extensions: {}, entries: [] }
          };
          setConfig({ lorebooks: [...config.lorebooks, book] });
        }}><Plus size={15} />新增</button>
      </div>
      {config.lorebooks.length ? <div className="roleplay-resource-list">{config.lorebooks.map((book) => (
        <details className="roleplay-resource" key={book.id}>
          <summary><Switch label={book.name} checked={book.enabled} onChange={(enabled) => updateBook(book.id, (value) => ({ ...value, enabled }))} /><span>{book.book.entries.length} 条</span></summary>
          <div className="roleplay-resource-body">
            <div className="grid-3">
              <Field label="名称"><input className="input" value={book.name} onChange={(event) => updateBook(book.id, (value) => ({ ...value, name: event.target.value, book: { ...value.book, name: event.target.value } }))} /></Field>
              <Field label="扫描深度"><input className="input" type="number" min={1} value={book.book.scan_depth ?? 4} onChange={(event) => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, scan_depth: Number(event.target.value) } }))} /></Field>
              <Field label="Token 预算"><input className="input" type="number" min={1} value={book.book.token_budget ?? ""} placeholder="自动" onChange={(event) => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, token_budget: event.target.value ? Number(event.target.value) : undefined } }))} /></Field>
            </div>
            <div className="roleplay-entry-list">{book.book.entries.map((entry, index) => (
              <details className="roleplay-entry" key={`${book.id}-${index}`}>
                <summary><strong>{entry.name || entry.comment || entry.keys.join("、") || `条目 ${index + 1}`}</strong><span>{entry.constant ? "常驻" : entry.keys.join(" · ")}</span></summary>
                <div className="roleplay-entry-body">
                  <div className="grid-3">
                    <Field label="名称"><input className="input" value={entry.name ?? ""} onChange={(event) => updateEntry(book, index, { name: event.target.value })} /></Field>
                    <Field label="关键词"><input className="input" value={entry.keys.join(", ")} onChange={(event) => updateEntry(book, index, { keys: event.target.value.split(",").map((key) => key.trim()).filter(Boolean) })} /></Field>
                    <Field label="位置"><select className="select" value={entry.position ?? "before_char"} onChange={(event) => updateEntry(book, index, { position: event.target.value as CharacterBookEntry["position"] })}><option value="before_char">角色前</option><option value="after_char">角色后</option><option value="before_examples">示例前</option><option value="after_examples">示例后</option><option value="at_depth">聊天深度</option></select></Field>
                  </div>
                  <div className="roleplay-trigger-row">
                    <label className="check-row"><input type="checkbox" checked={entry.enabled !== false} onChange={(event) => updateEntry(book, index, { enabled: event.target.checked })} />启用</label>
                    <label className="check-row"><input type="checkbox" checked={entry.constant ?? false} onChange={(event) => updateEntry(book, index, { constant: event.target.checked })} />常驻</label>
                    <label className="check-row"><input type="checkbox" checked={entry.case_sensitive ?? false} onChange={(event) => updateEntry(book, index, { case_sensitive: event.target.checked })} />区分大小写</label>
                  </div>
                  <ExpandableTextarea label="条目内容" value={entry.content} onChange={(content) => updateEntry(book, index, { content })} />
                  <button className="btn small danger" onClick={() => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, entries: value.book.entries.filter((_, current) => current !== index) } }))}><Trash2 size={15} />删除条目</button>
                </div>
              </details>
            ))}</div>
            <div className="row compact">
              <button className="btn small" onClick={() => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, entries: [...value.book.entries, { keys: [], content: "", extensions: {}, enabled: true, insertion_order: value.book.entries.length }] } }))}><Plus size={15} />新增条目</button>
              <button className="btn small danger" onClick={() => setConfig({ lorebooks: config.lorebooks.filter((item) => item.id !== book.id) })}><Trash2 size={15} />删除世界书</button>
            </div>
          </div>
        </details>
      ))}</div> : <p className="small muted">没有附加世界书。</p>}
    </section>
  );
}

function AssetsEditor({ agent, config, onReplace }: { agent: AgentDto; config: AgentRoleplayConfig; onReplace: (agent: AgentDto) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [type, setType] = useState("background");
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      await endpoints.updateAgent(agent.id, { card: agent.card, execution: agent.execution, userProfile: agent.userProfile, roleplay: agent.roleplay });
      const updated = await endpoints.uploadRoleplayAsset(agent.id, file, await fileToBase64(file), type);
      onReplace(updated); await refreshAgents(); toast("success", "素材已保存到当前 Agent");
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>角色素材</h3><p className="small muted">背景、表情和人物头像可显示；音频、视频及其他资源仅保存和导出。</p></div>
        <div className="row compact">
          <select className="select compact-select" value={type} onChange={(event) => setType(event.target.value)}><option value="background">背景</option><option value="expression">表情</option><option value="icon">头像</option><option value="audio">音频</option><option value="video">视频</option><option value="asset">其他</option></select>
          <input ref={input} className="sr-only" type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
          <button className="btn small" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />上传</button>
        </div>
      </div>
      {config.assets.length ? <div className="roleplay-asset-list">{config.assets.map((asset) => (
        <div className="roleplay-asset" key={asset.id}>
          {asset.mimeType?.startsWith("image/") ? <img src={asset.uri} alt="" /> : <span className="roleplay-file-icon"><File size={18} /></span>}
          <span className="grow"><strong>{asset.name}</strong><small>{asset.type} · {asset.ext}</small></span>
          <a className="btn ghost icon" href={asset.uri} download={asset.name} aria-label={`下载 ${asset.name}`}>{asset.mimeType?.startsWith("image/") ? <Image size={15} /> : <File size={15} />}</a>
          <button className="btn ghost icon danger" disabled={busy} aria-label={`删除 ${asset.name}`} onClick={() => void (async () => {
            setBusy(true); try { await endpoints.deleteRoleplayAsset(agent.id, asset.id); const updated = await endpoints.agent(agent.id); onReplace(updated); await refreshAgents(); } catch (error) { toastError(error); } finally { setBusy(false); }
          })()}><Trash2 size={15} /></button>
        </div>
      ))}</div> : <p className="small muted">没有角色素材。CHARX 内嵌素材会在导入时存入这里。</p>}
    </section>
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
