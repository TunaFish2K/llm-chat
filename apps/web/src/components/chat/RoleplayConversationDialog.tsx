import { t, useLocale, localized } from "../../lib/i18n";
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
  useLocale();
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
      toast("success", localized("RoleplayConversationDialog.roleplay_conversation_settings_updated"));
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
      title={t("RoleplayConversationDialog.roleplay_conversation_settings")}
      wide
      onClose={onClose}
      footer={<><Button onClick={onClose}>{t("WorkspaceSidebar.cancel")}</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{t("WorkspaceSidebar.save")}</Button></>}
    >
      <p className="small muted">{t("RoleplayConversationDialog.these_overrides_apply_only_to_this_conversation_the_agent_defaults")}</p>
      <div className="grid-2 roleplay-conversation-grid">
        <Field label={t("RoleplayTab.prompt_presets")}><select className="select" aria-label={t("RoleplayTab.prompt_presets")} value={state.presetId ?? ""} onChange={(event) => patch({ presetId: event.target.value || null })}>{agent.roleplay.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field>
        <Field label={t("RoleplayTab.user_personas")}><select className="select" aria-label={t("RoleplayTab.user_personas")} value={state.personaId ?? ""} onChange={(event) => patch({ personaId: event.target.value || null })}><option value="">{t("RoleplayConversationDialog.use_global_profile")}</option>{agent.roleplay.personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></Field>
        <Field label={t("RoleplayConversationDialog.chat_background")}><select className="select" aria-label={t("RoleplayConversationDialog.chat_background")} value={state.backgroundAssetId ?? ""} onChange={(event) => patch({ backgroundAssetId: event.target.value || null })}><option value="">{t("RoleplayTab.none")}</option>{images.filter((asset) => asset.type === "background").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
        <Field label={t("RoleplayConversationDialog.character_expression")}><select className="select" aria-label={t("RoleplayConversationDialog.character_expression")} value={state.expressionAssetId ?? ""} onChange={(event) => patch({ expressionAssetId: event.target.value || null })}><option value="">{t("RoleplayTab.none")}</option>{images.filter((asset) => asset.type === "expression").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
      </div>
      {agent.roleplay.lorebooks.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>{t("RoleplayConversationDialog.enabled_lorebooks")}</legend><div className="roleplay-choice-grid">{agent.roleplay.lorebooks.map((book) => <label className="check-row" key={book.id}><input type="checkbox" checked={state.enabledLorebookIds.includes(book.id)} onChange={(event) => patch({ enabledLorebookIds: event.target.checked ? [...new Set([...state.enabledLorebookIds, book.id])] : state.enabledLorebookIds.filter((id) => id !== book.id) })} />{book.name}</label>)}</div></fieldset>
      ) : null}
      {agent.roleplay.regexScripts.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>{t("RoleplayConversationDialog.enabled_safe_regex_rules")}</legend><div className="roleplay-choice-grid">{agent.roleplay.regexScripts.filter((script) => script.enabled).map((script) => <label className="check-row" key={script.id}><input type="checkbox" checked={state.enabledRegexScriptIds.includes(script.id)} onChange={(event) => patch({ enabledRegexScriptIds: event.target.checked ? [...new Set([...state.enabledRegexScriptIds, script.id])] : state.enabledRegexScriptIds.filter((id) => id !== script.id) })} />{script.name}</label>)}</div></fieldset>
      ) : null}
      {agent.roleplay.quickReplySets.length ? (
        <fieldset className="roleplay-choice-fieldset"><legend>{t("RoleplayConversationDialog.enabled_quick_reply_groups")}</legend><div className="roleplay-choice-grid">{agent.roleplay.quickReplySets.filter((set) => set.enabled).map((set) => <label className="check-row" key={set.id}><input type="checkbox" checked={state.enabledQuickReplySetIds.includes(set.id)} onChange={(event) => patch({ enabledQuickReplySetIds: event.target.checked ? [...new Set([...state.enabledQuickReplySetIds, set.id])] : state.enabledQuickReplySetIds.filter((id) => id !== set.id) })} />{set.name}</label>)}</div></fieldset>
      ) : null}
      <ExpandableTextarea label={t("RoleplayConversationDialog.scenario_override")} value={state.scenarioOverride} placeholder={t("RoleplayConversationDialog.leave_blank_to_use_the_character_card_scenario")} onChange={(scenarioOverride) => patch({ scenarioOverride })} />
      <ExpandableTextarea label={t("RoleplayTab.author_s_note")} value={state.authorNote} placeholder={t("RoleplayConversationDialog.a_conversation_note_that_can_be_injected_into_each_turn")} onChange={(authorNote) => patch({ authorNote })} />
      <details className="roleplay-audit">
        <summary onClick={() => {
          if (audit === null) void endpoints.roleplayScriptAudit(conversationId).then(setAudit).catch(toastError);
        }}>{t("RoleplayConversationDialog.script_execution_history")}</summary>
        {audit === null ? <p className="small muted">{t("RoleplayConversationDialog.expand_to_load_the_latest_200_records")}</p> : audit.length ? (
          <div className="roleplay-audit-list">{audit.map((item) => (
            <div key={String(item.id)}><strong>{item.success ? t("index.completed") : t("index.failed")}</strong><span>{t("RoleplayConversationDialog.commands", { value1: (String(item.sourceKind)), value2: (String(item.commandCount)) })}</span>{item.error ? <small>{String(item.error)}</small> : null}</div>
          ))}</div>
        ) : <p className="small muted">{t("RoleplayConversationDialog.no_script_executions_yet")}</p>}
      </details>
    </Modal>
  );
}
