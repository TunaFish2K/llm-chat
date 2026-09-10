import { useState } from "react";
import type { AgentDto, ConversationRoleplayState, ConversationRoleplayStatePatch } from "@llm-chat/contracts";
import { endpoints } from "../../lib/api";
import { toast, toastError } from "../../lib/app-state";
import { ExpandableTextarea } from "../ExpandableTextarea";
import { Button, Field, Modal } from "../ui";

export function RoleplayConversationDialog({
  conversationId,
  agent,
  initial,
  onClose,
  onSaved
}: {
  conversationId: string;
  agent: AgentDto;
  initial: ConversationRoleplayState;
  onClose: () => void;
  onSaved: (state: ConversationRoleplayState) => void;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Array<Record<string, unknown>> | null>(null);
  const patch = (value: ConversationRoleplayStatePatch) => setState((current) => ({
    ...current,
    ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  } as ConversationRoleplayState));
  const save = async () => {
    setBusy(true);
    try {
      let updated = await endpoints.updateConversationRoleplayState(conversationId, state);
      const loreChanged = initial.enabledLorebookIds.join("\u0000") !== updated.enabledLorebookIds.join("\u0000");
      const activeSets = agent.roleplay.quickReplySets.filter((set) =>
        set.enabled && updated.enabledQuickReplySetIds.includes(set.id)
      );
      if (loreChanged && activeSets.some((set) => set.replies.some((reply) =>
        reply.enabled && reply.mode === "script" && reply.autoTriggers.includes("lore_activated")
      ))) {
        const automated = await endpoints.executeRoleplayScript(conversationId, { trigger: "lore_activated", draft: "" });
        updated = automated.state;
      }
      onSaved(updated);
      toast("success", "角色会话设置已更新");
      onClose();
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };
  const images = agent.roleplay.assets.filter((asset) => asset.mimeType?.startsWith("image/"));
  return (
    <Modal
      title="角色会话设置"
      wide
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => save()}>保存</Button></>}
    >
      <p className="small muted">这些覆盖只属于当前会话；Agent 的默认配置不会改变。</p>
      <div className="grid-2 roleplay-conversation-grid">
        <Field label="提示预设"><select className="select" aria-label="提示预设" value={state.presetId ?? ""} onChange={(event) => patch({ presetId: event.target.value || null })}>{agent.roleplay.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field>
        <Field label="人物身份"><select className="select" aria-label="人物身份" value={state.personaId ?? ""} onChange={(event) => patch({ personaId: event.target.value || null })}><option value="">使用全局资料</option>{agent.roleplay.personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></Field>
        <Field label="聊天背景"><select className="select" aria-label="聊天背景" value={state.backgroundAssetId ?? ""} onChange={(event) => patch({ backgroundAssetId: event.target.value || null })}><option value="">不使用</option>{images.filter((asset) => asset.type === "background").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
        <Field label="角色表情"><select className="select" aria-label="角色表情" value={state.expressionAssetId ?? ""} onChange={(event) => patch({ expressionAssetId: event.target.value || null })}><option value="">不使用</option>{images.filter((asset) => asset.type === "expression").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
      </div>
      {agent.roleplay.lorebooks.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>启用世界书</legend><div className="roleplay-choice-grid">{agent.roleplay.lorebooks.map((book) => <label className="check-row" key={book.id}><input type="checkbox" checked={state.enabledLorebookIds.includes(book.id)} onChange={(event) => patch({ enabledLorebookIds: event.target.checked ? [...new Set([...state.enabledLorebookIds, book.id])] : state.enabledLorebookIds.filter((id) => id !== book.id) })} />{book.name}</label>)}</div></fieldset>
      ) : null}
      {agent.roleplay.regexScripts.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>启用安全正则</legend><div className="roleplay-choice-grid">{agent.roleplay.regexScripts.filter((script) => script.enabled).map((script) => <label className="check-row" key={script.id}><input type="checkbox" checked={state.enabledRegexScriptIds.includes(script.id)} onChange={(event) => patch({ enabledRegexScriptIds: event.target.checked ? [...new Set([...state.enabledRegexScriptIds, script.id])] : state.enabledRegexScriptIds.filter((id) => id !== script.id) })} />{script.name}</label>)}</div></fieldset>
      ) : null}
      {agent.roleplay.quickReplySets.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>启用快捷回复组</legend><div className="roleplay-choice-grid">{agent.roleplay.quickReplySets.filter((set) => set.enabled).map((set) => <label className="check-row" key={set.id}><input type="checkbox" checked={state.enabledQuickReplySetIds.includes(set.id)} onChange={(event) => patch({ enabledQuickReplySetIds: event.target.checked ? [...new Set([...state.enabledQuickReplySetIds, set.id])] : state.enabledQuickReplySetIds.filter((id) => id !== set.id) })} />{set.name}</label>)}</div></fieldset>
      ) : null}
      <ExpandableTextarea label="场景覆盖" value={state.scenarioOverride} placeholder="留空时使用角色卡场景" onChange={(scenarioOverride) => patch({ scenarioOverride })} />
      <ExpandableTextarea label="作者注释" value={state.authorNote} placeholder="可在每轮提示中注入的会话备注" onChange={(authorNote) => patch({ authorNote })} />
      <details className="roleplay-audit">
        <summary onClick={() => {
          if (audit === null) void endpoints.roleplayScriptAudit(conversationId).then(setAudit).catch(toastError);
        }}>脚本执行记录</summary>
        {audit === null ? <p className="small muted">展开后加载最近 200 条记录。</p> : audit.length ? (
          <div className="roleplay-audit-list">{audit.map((item) => (
            <div key={String(item.id)}><strong>{item.success ? "已完成" : "失败"}</strong><span>{String(item.sourceKind)} · {String(item.commandCount)} 条命令</span>{item.error ? <small>{String(item.error)}</small> : null}</div>
          ))}</div>
        ) : <p className="small muted">还没有脚本执行记录。</p>}
      </details>
    </Modal>
  );
}
