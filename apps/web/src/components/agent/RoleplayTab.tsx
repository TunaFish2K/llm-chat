import { t, useLocale, localized } from "../../lib/i18n";
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

function getBLOCK_KINDS(): Array<[RoleplayPromptBlock["kind"], string]> { return [
  ["main", t("RoleplayTab.main_prompt")], ["lore_before", t("RoleplayTab.world_info_before_character")], ["character", t("RoleplayTab.character_definition")],
  ["lore_after", t("RoleplayTab.world_info_after_character")], ["persona", t("RoleplayTab.user_persona")], ["examples", t("AgentEditorView.example_dialogue")],
  ["history", t("RoleplayTab.chat_history")], ["author_note", t("RoleplayTab.author_s_note")], ["post_history", t("AgentEditorView.post_history_instructions")], ["custom", t("RoleplayTab.custom")]
]; }
function getTRIGGERS(): Array<[RoleplayGenerationTrigger, string]> { return [
  ["normal", t("RoleplayTab.normal")], ["continue", t("RoleplayTab.continue")], ["regenerate", t("RoleplayTab.regenerate")], ["script", t("RoleplayTab.script")]
]; }

export function RoleplayTab({
  agent,
  mutate,
  onReplace
}: {
  agent: AgentDto;
  mutate: (fn: (draft: AgentDto) => void) => void;
  onReplace: (agent: AgentDto) => void;
}) {
  useLocale();
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
      toast("success", localized("RoleplayTab.preset_imported_and_saved"));
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
            <h3>{t("RoleplayTab.roleplay_workflow")}</h3>
            <p className="small muted">{t("RoleplayTab.presets_personas_lorebooks_and_scripts_belong_only_to_this_agent")}</p>
          </div>
          <Switch label={t("RoleplayTab.enable_roleplay")} checked={config.enabled} onChange={(enabled) => setConfig({ enabled })} />
        </div>
      </div>

      <div className="card">
        <div className="field-heading roleplay-preset-heading">
          <div>
            <h3>{t("RoleplayTab.prompt_presets")}</h3>
            <p className="small muted">{t("RoleplayTab.supports_native_presets_and_common_sillytavern_json_presets")}</p>
          </div>
          <div className="row compact">
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              aria-label={t("RoleplayTab.import_sillytavern_preset")}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importPreset(file);
              }}
            />
            <button className="btn small" disabled={busy} onClick={() => input.current?.click()}>
              <Upload size={15} aria-hidden="true" />{t("RoleplayTab.import")}</button>
            <button className="btn small" disabled={!preset} onClick={() => preset && duplicatePreset(config, preset, setConfig)}>
              <Copy size={15} aria-hidden="true" />{t("RichPreview.copy")}</button>
            <button
              className="btn small danger"
              disabled={!preset || config.presets.length <= 1}
              onClick={() => {
                if (!preset) return;
                const presets = config.presets.filter((item) => item.id !== preset.id);
                setConfig({ presets, defaultPresetId: presets[0]?.id ?? null });
              }}
            >
              <Trash2 size={15} aria-hidden="true" />{t("WorkspaceSidebar.delete_2")}</button>
          </div>
        </div>

        <Field label={t("RoleplayTab.current_default_preset")}>
          <select className="select" value={activeId ?? ""} onChange={(event) => setConfig({ defaultPresetId: event.target.value })}>
            {config.presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>

        {preset ? (
          <PresetEditor preset={preset} updatePreset={updatePreset} />
        ) : (
          <EmptyState title={t("RoleplayTab.no_presets")} hint={t("RoleplayTab.reload_the_agent_to_create_a_default_preset_automatically")} />
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
  useLocale();
  const update = (id: string, patch: Partial<AgentRegexScript>) => setConfig({
    regexScripts: config.regexScripts.map((script) => script.id === id ? { ...script, ...patch } : script)
  });
  const scopes: Array<[AgentRegexScript["scopes"][number], string]> = [
    ["user_prompt", t("RoleplayTab.user_prompt")], ["assistant_prompt", t("RoleplayTab.assistant_history")], ["world_info", t("RoleplayTab.world_info")], ["display", t("RoleplayTab.display")]
  ];
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>{t("RoleplayTab.safe_regex")}</h3><p className="small muted">{t("RoleplayTab.uses_the_re2_linear_time_engine_imported_rules_are_disabled")}</p></div>
        <button className="btn small" onClick={() => setConfig({ regexScripts: [...config.regexScripts, { id: crypto.randomUUID(), name: t("RoleplayTab.new_regex"), enabled: false, pattern: "", replacement: "", flags: "gu", scopes: ["display"], runOnEdit: false, importWarning: null }] })}><Plus size={15} />{t("AgentEditorView.add")}</button>
      </div>
      {config.regexScripts.length ? <div className="roleplay-resource-list">{config.regexScripts.map((script) => (
        <details className="roleplay-resource" key={script.id}>
          <summary><Switch label={script.name} checked={script.enabled} onChange={(enabled) => update(script.id, { enabled })} /><span>{script.scopes.map((scope) => scopes.find(([id]) => id === scope)?.[1]).filter(Boolean).join(" · ")}</span></summary>
          <div className="roleplay-resource-body">
            {script.importWarning ? <div className="notice warning">{script.importWarning}</div> : null}
            <div className="grid-2"><Field label={t("SettingsView.name")}><input className="input" value={script.name} onChange={(event) => update(script.id, { name: event.target.value })} /></Field><Field label={t("RoleplayTab.flags")}><input className="input" value={script.flags} onChange={(event) => update(script.id, { flags: event.target.value })} /></Field></div>
            <ExpandableTextarea label={t("RoleplayTab.match_expression")} value={script.pattern} onChange={(pattern) => update(script.id, { pattern })} />
            <ExpandableTextarea label={t("RoleplayTab.replacement")} value={script.replacement} onChange={(replacement) => update(script.id, { replacement })} />
            <div className="roleplay-trigger-row">{scopes.map(([scope, label]) => <label className="check-row" key={scope}><input type="checkbox" checked={script.scopes.includes(scope)} onChange={(event) => update(script.id, { scopes: event.target.checked ? [...new Set([...script.scopes, scope])] : script.scopes.filter((item) => item !== scope) })} />{label}</label>)}</div>
            <button className="btn small danger" onClick={() => setConfig({ regexScripts: config.regexScripts.filter((item) => item.id !== script.id) })}><Trash2 size={15} />{t("WorkspaceSidebar.delete_2")}</button>
          </div>
        </details>
      ))}</div> : <p className="small muted">{t("RoleplayTab.no_regex_scripts")}</p>}
    </section>
  );
}

function QuickRepliesEditor({ config, setConfig }: { config: AgentRoleplayConfig; setConfig: (patch: Partial<AgentRoleplayConfig>) => void }) {
  useLocale();
  const updateSet = (id: string, fn: (set: AgentQuickReplySet) => AgentQuickReplySet) => setConfig({
    quickReplySets: config.quickReplySets.map((set) => set.id === id ? fn(set) : set)
  });
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>{t("RoleplayTab.quick_replies_and_restricted_scripts")}</h3><p className="small muted">{t("RoleplayTab.scripts_can_change_only_this_roleplay_conversation_s_variables_preset")}</p></div>
        <button className="btn small" onClick={() => setConfig({ quickReplySets: [...config.quickReplySets, { id: crypto.randomUUID(), name: t("RoleplayTab.new_quick_reply_group"), enabled: true, replies: [] }] })}><Plus size={15} />{t("RoleplayTab.add_group")}</button>
      </div>
      {config.quickReplySets.length ? <div className="roleplay-resource-list">{config.quickReplySets.map((set) => (
        <details className="roleplay-resource" key={set.id}>
          <summary><Switch label={set.name} checked={set.enabled} onChange={(enabled) => updateSet(set.id, (value) => ({ ...value, enabled }))} /><span>{t("RoleplayTab.items", { count: Number((set.replies.length)), value1: (set.replies.length) })}</span></summary>
          <div className="roleplay-resource-body">
            <Field label={t("RoleplayTab.group_name")}><input className="input" value={set.name} onChange={(event) => updateSet(set.id, (value) => ({ ...value, name: event.target.value }))} /></Field>
            <div className="roleplay-entry-list">{set.replies.map((reply, index) => (
              <details className="roleplay-entry" key={reply.id}>
                <summary><strong>{reply.label}</strong><span>{reply.mode === "insert" ? t("RoleplayTab.insert") : reply.mode === "send" ? t("RoleplayTab.send") : t("RoleplayTab.restricted_script")}</span></summary>
                <div className="roleplay-entry-body">
                  <div className="grid-3"><Field label={t("RoleplayTab.button_text")}><input className="input" value={reply.label} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, label: event.target.value } : item) }))} /></Field><Field label={t("TasksView.mode")}><select className="select" value={reply.mode} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, mode: event.target.value as typeof reply.mode } : item) }))}><option value="insert">{t("RoleplayTab.insert_into_draft")}</option><option value="send">{t("RoleplayTab.send_immediately")}</option><option value="script">{t("RoleplayTab.restricted_stscript")}</option></select></Field><Field label={t("RoleplayTab.tooltip")}><input className="input" value={reply.tooltip} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, tooltip: event.target.value } : item) }))} /></Field></div>
                  <ExpandableTextarea label={reply.mode === "script" ? t("RoleplayTab.script") : t("RoleplayTab.content")} value={reply.content} onChange={(content) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, content } : item) }))} />
                  <div className="roleplay-trigger-row"><label className="check-row"><input type="checkbox" checked={reply.enabled} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, enabled: event.target.checked } : item) }))} />{t("SettingsView.enable")}</label><label className="check-row"><input type="checkbox" checked={reply.pinned} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, pinned: event.target.checked } : item) }))} />{t("RoleplayTab.pin")}</label>{reply.mode === "script" ? (["new_chat", "before_send", "after_reply", "lore_activated"] as const).map((trigger) => <label className="check-row" key={trigger}><input type="checkbox" checked={reply.autoTriggers.includes(trigger)} onChange={(event) => updateSet(set.id, (value) => ({ ...value, replies: value.replies.map((item, current) => current === index ? { ...item, autoTriggers: event.target.checked ? [...new Set([...item.autoTriggers, trigger])] : item.autoTriggers.filter((value) => value !== trigger) } : item) }))} />{trigger}</label>) : null}</div>
                  <button className="btn small danger" onClick={() => updateSet(set.id, (value) => ({ ...value, replies: value.replies.filter((_, current) => current !== index) }))}><Trash2 size={15} />{t("WorkspaceSidebar.delete_2")}</button>
                </div>
              </details>
            ))}</div>
            <div className="row compact"><button className="btn small" onClick={() => updateSet(set.id, (value) => ({ ...value, replies: [...value.replies, { id: crypto.randomUUID(), label: t("RoleplayTab.new_quick_reply"), tooltip: "", mode: "insert", content: "", enabled: true, pinned: false, autoTriggers: [] }] }))}><Plus size={15} />{t("RoleplayTab.add_quick_reply")}</button><button className="btn small danger" onClick={() => setConfig({ quickReplySets: config.quickReplySets.filter((item) => item.id !== set.id) })}><Trash2 size={15} />{t("RoleplayTab.delete_group")}</button></div>
          </div>
        </details>
      ))}</div> : <p className="small muted">{t("RoleplayTab.no_quick_replies")}</p>}
    </section>
  );
}

function PersonasEditor({ config, setConfig }: {
  config: AgentRoleplayConfig;
  setConfig: (patch: Partial<AgentRoleplayConfig>) => void;
}) {
  useLocale();
  const update = (id: string, patch: Partial<AgentPersona>) => setConfig({
    personas: config.personas.map((item) => item.id === id ? { ...item, ...patch } : item)
  });
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>{t("RoleplayTab.user_personas")}</h3><p className="small muted">{t("RoleplayTab.replaces_the_global_user_profile_only_in_this_agent_s")}</p></div>
        <button className="btn small" onClick={() => {
          const persona: AgentPersona = { id: crypto.randomUUID(), name: t("RoleplayTab.new_persona"), description: "", avatarAssetId: null };
          setConfig({ personas: [...config.personas, persona], defaultPersonaId: config.defaultPersonaId ?? persona.id });
        }}><Plus size={15} />{t("AgentEditorView.add")}</button>
      </div>
      {config.personas.length ? <div className="roleplay-resource-list">{config.personas.map((persona) => (
        <details className="roleplay-resource" key={persona.id}>
          <summary><strong>{persona.name}</strong>{config.defaultPersonaId === persona.id ? <span className="tag accent">{t("AgentEditorView.default")}</span> : null}</summary>
          <div className="roleplay-resource-body">
            <Field label={t("SettingsView.name")}><input className="input" aria-label={t("RoleplayTab.persona_name", { value1: (persona.name) })} value={persona.name} onChange={(event) => update(persona.id, { name: event.target.value })} /></Field>
            <ExpandableTextarea label={t("RoleplayTab.persona_description")} value={persona.description} onChange={(description) => update(persona.id, { description })} />
            <Field label={t("RoleplayTab.persona_avatar_asset")}>
              <select className="select" value={persona.avatarAssetId ?? ""} onChange={(event) => update(persona.id, { avatarAssetId: event.target.value || null })}>
                <option value="">{t("RoleplayTab.none")}</option>
                {config.assets.filter((asset) => asset.mimeType?.startsWith("image/")).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
            </Field>
            <div className="row compact">
              <button className="btn small" onClick={() => setConfig({ defaultPersonaId: persona.id })}>{t("RoleplayTab.set_as_default")}</button>
              <button className="btn small danger" onClick={() => setConfig({
                personas: config.personas.filter((item) => item.id !== persona.id),
                defaultPersonaId: config.defaultPersonaId === persona.id ? null : config.defaultPersonaId
              })}><Trash2 size={15} />{t("WorkspaceSidebar.delete_2")}</button>
            </div>
          </div>
        </details>
      ))}</div> : <p className="small muted">{t("RoleplayTab.without_a_persona_the_agent_or_global_user_profile_is")}</p>}
    </section>
  );
}

function LorebooksEditor({ config, setConfig }: {
  config: AgentRoleplayConfig;
  setConfig: (patch: Partial<AgentRoleplayConfig>) => void;
}) {
  useLocale();
  const updateBook = (id: string, fn: (book: AgentLorebook) => AgentLorebook) => setConfig({
    lorebooks: config.lorebooks.map((book) => book.id === id ? fn(book) : book)
  });
  const updateEntry = (book: AgentLorebook, index: number, patch: Partial<CharacterBookEntry>) => updateBook(book.id, (value) => ({
    ...value, book: { ...value.book, entries: value.book.entries.map((entry, current) => current === index ? { ...entry, ...patch } : entry) }
  }));
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>{t("RoleplayTab.additional_lorebooks")}</h3><p className="small muted">{t("RoleplayTab.injected_by_keyword_and_budget_the_character_card_s_built")}</p></div>
        <button className="btn small" onClick={() => {
          const book: AgentLorebook = {
            id: crypto.randomUUID(), name: t("RoleplayTab.new_lorebook"), enabled: true,
            book: { name: t("RoleplayTab.new_lorebook"), description: "", scan_depth: 4, recursive_scanning: false, extensions: {}, entries: [] }
          };
          setConfig({ lorebooks: [...config.lorebooks, book] });
        }}><Plus size={15} />{t("AgentEditorView.add")}</button>
      </div>
      {config.lorebooks.length ? <div className="roleplay-resource-list">{config.lorebooks.map((book) => (
        <details className="roleplay-resource" key={book.id}>
          <summary><Switch label={book.name} checked={book.enabled} onChange={(enabled) => updateBook(book.id, (value) => ({ ...value, enabled }))} /><span>{t("RoleplayTab.entries", { value1: (book.book.entries.length) })}</span></summary>
          <div className="roleplay-resource-body">
            <div className="grid-3">
              <Field label={t("SettingsView.name")}><input className="input" value={book.name} onChange={(event) => updateBook(book.id, (value) => ({ ...value, name: event.target.value, book: { ...value.book, name: event.target.value } }))} /></Field>
              <Field label={t("RoleplayTab.scan_depth")}><input className="input" type="number" min={1} value={book.book.scan_depth ?? 4} onChange={(event) => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, scan_depth: Number(event.target.value) } }))} /></Field>
              <Field label={t("RoleplayTab.token_budget")}><input className="input" type="number" min={1} value={book.book.token_budget ?? ""} placeholder={t("ConnectionsView.automatic")} onChange={(event) => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, token_budget: event.target.value ? Number(event.target.value) : undefined } }))} /></Field>
            </div>
            <div className="roleplay-entry-list">{book.book.entries.map((entry, index) => (
              <details className="roleplay-entry" key={`${book.id}-${index}`}>
                <summary><strong>{entry.name || entry.comment || entry.keys.join("、") || t("RoleplayTab.entry", { value1: (index + 1) })}</strong><span>{entry.constant ? t("RoleplayTab.always_active") : entry.keys.join(" · ")}</span></summary>
                <div className="roleplay-entry-body">
                  <div className="grid-3">
                    <Field label={t("SettingsView.name")}><input className="input" value={entry.name ?? ""} onChange={(event) => updateEntry(book, index, { name: event.target.value })} /></Field>
                    <Field label={t("RoleplayTab.keywords")}><input className="input" value={entry.keys.join(", ")} onChange={(event) => updateEntry(book, index, { keys: event.target.value.split(",").map((key) => key.trim()).filter(Boolean) })} /></Field>
                    <Field label={t("RoleplayTab.position")}><select className="select" value={entry.position ?? "before_char"} onChange={(event) => updateEntry(book, index, { position: event.target.value as CharacterBookEntry["position"] })}><option value="before_char">{t("RoleplayTab.before_character")}</option><option value="after_char">{t("RoleplayTab.after_character")}</option><option value="before_examples">{t("RoleplayTab.before_examples")}</option><option value="after_examples">{t("RoleplayTab.after_examples")}</option><option value="at_depth">{t("RoleplayTab.chat_depth")}</option></select></Field>
                  </div>
                  <div className="roleplay-trigger-row">
                    <label className="check-row"><input type="checkbox" checked={entry.enabled !== false} onChange={(event) => updateEntry(book, index, { enabled: event.target.checked })} />{t("SettingsView.enable")}</label>
                    <label className="check-row"><input type="checkbox" checked={entry.constant ?? false} onChange={(event) => updateEntry(book, index, { constant: event.target.checked })} />{t("RoleplayTab.always_active")}</label>
                    <label className="check-row"><input type="checkbox" checked={entry.case_sensitive ?? false} onChange={(event) => updateEntry(book, index, { case_sensitive: event.target.checked })} />{t("RoleplayTab.case_sensitive")}</label>
                  </div>
                  <ExpandableTextarea label={t("RoleplayTab.entry_content")} value={entry.content} onChange={(content) => updateEntry(book, index, { content })} />
                  <button className="btn small danger" onClick={() => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, entries: value.book.entries.filter((_, current) => current !== index) } }))}><Trash2 size={15} />{t("RoleplayTab.delete_entry")}</button>
                </div>
              </details>
            ))}</div>
            <div className="row compact">
              <button className="btn small" onClick={() => updateBook(book.id, (value) => ({ ...value, book: { ...value.book, entries: [...value.book.entries, { keys: [], content: "", extensions: {}, enabled: true, insertion_order: value.book.entries.length }] } }))}><Plus size={15} />{t("RoleplayTab.add_entry")}</button>
              <button className="btn small danger" onClick={() => setConfig({ lorebooks: config.lorebooks.filter((item) => item.id !== book.id) })}><Trash2 size={15} />{t("RoleplayTab.delete_lorebook")}</button>
            </div>
          </div>
        </details>
      ))}</div> : <p className="small muted">{t("RoleplayTab.no_additional_lorebooks")}</p>}
    </section>
  );
}

function AssetsEditor({ agent, config, onReplace }: { agent: AgentDto; config: AgentRoleplayConfig; onReplace: (agent: AgentDto) => void }) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [type, setType] = useState("background");
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      await endpoints.updateAgent(agent.id, { card: agent.card, execution: agent.execution, userProfile: agent.userProfile, roleplay: agent.roleplay });
      const updated = await endpoints.uploadRoleplayAsset(agent.id, file, await fileToBase64(file), type);
      onReplace(updated); await refreshAgents(); toast("success", localized("RoleplayTab.asset_saved_to_this_agent"));
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };
  return (
    <section className="card roleplay-resource-section">
      <div className="field-heading">
        <div><h3>{t("RoleplayTab.character_assets")}</h3><p className="small muted">{t("RoleplayTab.backgrounds_expressions_and_persona_avatars_can_be_displayed_audio_video")}</p></div>
        <div className="row compact">
          <select className="select compact-select" value={type} onChange={(event) => setType(event.target.value)}><option value="background">{t("RoleplayTab.background")}</option><option value="expression">{t("RoleplayTab.expression")}</option><option value="icon">{t("AgentEditorView.avatar")}</option><option value="audio">{t("RoleplayTab.audio")}</option><option value="video">{t("RoleplayTab.video")}</option><option value="asset">{t("RoleplayTab.other")}</option></select>
          <input ref={input} className="sr-only" type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
          <button className="btn small" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{t("RoleplayTab.upload")}</button>
        </div>
      </div>
      {config.assets.length ? <div className="roleplay-asset-list">{config.assets.map((asset) => (
        <div className="roleplay-asset" key={asset.id}>
          {asset.mimeType?.startsWith("image/") ? <img src={asset.uri} alt="" /> : <span className="roleplay-file-icon"><File size={18} /></span>}
          <span className="grow"><strong>{asset.name}</strong><small>{asset.type} · {asset.ext}</small></span>
          <a className="btn ghost icon" href={asset.uri} download={asset.name} aria-label={t("RoleplayTab.download", { value1: (asset.name) })}>{asset.mimeType?.startsWith("image/") ? <Image size={15} /> : <File size={15} />}</a>
          <button className="btn ghost icon danger" disabled={busy} aria-label={t("WorkspaceSidebar.delete", { value1: (asset.name) })} onClick={() => void (async () => {
            setBusy(true); try { await endpoints.deleteRoleplayAsset(agent.id, asset.id); const updated = await endpoints.agent(agent.id); onReplace(updated); await refreshAgents(); } catch (error) { toastError(error); } finally { setBusy(false); }
          })()}><Trash2 size={15} /></button>
        </div>
      ))}</div> : <p className="small muted">{t("RoleplayTab.no_character_assets_assets_embedded_in_charx_files_are_stored")}</p>}
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
  useLocale();
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
      <Field label={t("RoleplayTab.preset_name")}>
        <input className="input" value={preset.name} onChange={(event) => updatePreset((value) => ({ ...value, name: event.target.value }))} />
      </Field>
      {preset.importWarnings.length ? (
        <div className="notice warning" role="status">
          {preset.importWarnings.map((warning, index) => <div key={index}>{warning}</div>)}
        </div>
      ) : null}
      <div className="grid-3 roleplay-generation-grid">
        <GenerationNumber label={t("RoleplayTab.preset_temperature")} min={0} max={2} step={0.1} value={preset.generation.common?.temperature} onChange={(value) => updateGeneration({ temperature: value })} />
        <GenerationNumber label={t("RoleplayTab.preset_top_p")} min={0} max={1} step={0.05} value={preset.generation.common?.topP} onChange={(value) => updateGeneration({ topP: value })} />
        <GenerationNumber label={t("RoleplayTab.preset_output_limit")} min={1} value={preset.generation.common?.maxOutputTokens} onChange={(value) => updateGeneration({ maxOutputTokens: value })} />
      </div>
      <div className="roleplay-block-list">
        {preset.blocks.map((block, index) => (
          <div className="roleplay-block" key={block.id}>
            <div className="roleplay-block-heading">
              <Switch label={block.name} checked={block.enabled} onChange={(enabled) => updateBlock(block.id, { enabled })} />
              <div className="row compact">
                <button className="btn ghost icon" aria-label={t("ServiceSettingsPanel.move_up", { value1: (block.name) })} disabled={index === 0} onClick={() => moveBlock(index, -1)}><ArrowUp size={15} /></button>
                <button className="btn ghost icon" aria-label={t("ServiceSettingsPanel.move_down", { value1: (block.name) })} disabled={index === preset.blocks.length - 1} onClick={() => moveBlock(index, 1)}><ArrowDown size={15} /></button>
                <button
                  className="btn ghost icon danger"
                  aria-label={t("WorkspaceSidebar.delete", { value1: (block.name) })}
                  disabled={block.kind === "history" && preset.blocks.filter((item) => item.kind === "history").length === 1}
                  onClick={() => updatePreset((value) => ({
                    ...value,
                    blocks: value.blocks.filter((item) => item.id !== block.id).map((item, order) => ({ ...item, order }))
                  }))}
                ><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="roleplay-block-controls">
              <input className="input" aria-label={t("RoleplayTab.name", { value1: (block.name) })} value={block.name} onChange={(event) => updateBlock(block.id, { name: event.target.value })} />
              <select className="select" aria-label={t("RoleplayTab.type", { value1: (block.name) })} value={block.kind} onChange={(event) => updateBlock(block.id, { kind: event.target.value as RoleplayPromptBlock["kind"] })}>
                {getBLOCK_KINDS().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="select" aria-label={t("RoleplayTab.role", { value1: (block.name) })} value={block.role} onChange={(event) => updateBlock(block.id, { role: event.target.value as RoleplayPromptBlock["role"] })}>
                <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option>
              </select>
              <select className="select" aria-label={t("RoleplayTab.position_2", { value1: (block.name) })} value={block.position} onChange={(event) => updateBlock(block.id, { position: event.target.value as RoleplayPromptBlock["position"] })}>
                <option value="relative">{t("RoleplayTab.relative_order")}</option><option value="in_chat">{t("RoleplayTab.inject_into_chat")}</option>
              </select>
              {block.position === "in_chat" ? (
                <input className="input" type="number" min={0} aria-label={t("RoleplayTab.injection_depth", { value1: (block.name) })} value={block.depth} onChange={(event) => updateBlock(block.id, { depth: Number(event.target.value) })} />
              ) : null}
            </div>
            <div className="roleplay-trigger-row" aria-label={t("RoleplayTab.activation_triggers", { value1: (block.name) })}>
              {getTRIGGERS().map(([trigger, label]) => (
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
              <p className="small muted">{t("RoleplayTab.chat_history_is_inserted_here")}</p>
            ) : (
              <ExpandableTextarea label={t("RoleplayTab.content_2", { value1: (block.name) })} value={block.content} placeholder={t("RoleplayTab.leave_blank_to_use_the_corresponding_character_card_field")} onChange={(content) => updateBlock(block.id, { content })} />
            )}
          </div>
        ))}
      </div>
      <button className="btn small" onClick={() => updatePreset((value) => ({
        ...value,
        blocks: [...value.blocks, newBlock(value.blocks.length)]
      }))}>
        <Plus size={15} aria-hidden="true" />{t("RoleplayTab.add_prompt_block")}</button>
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
  useLocale();
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
    name: t("RoleplayTab.copy", { value1: (preset.name) }),
    importedFrom: "native",
    importWarnings: [],
    blocks: preset.blocks.map((block) => ({ ...block, id: crypto.randomUUID() }))
  };
  setConfig({ presets: [...config.presets, copy], defaultPresetId: copy.id });
}

function newBlock(order: number): RoleplayPromptBlock {
  return {
    id: crypto.randomUUID(), name: t("RoleplayTab.custom_prompt"), kind: "custom", enabled: true,
    role: "system", position: "relative", depth: 0, order,
    triggers: ["normal", "continue", "regenerate", "script"], content: ""
  };
}
