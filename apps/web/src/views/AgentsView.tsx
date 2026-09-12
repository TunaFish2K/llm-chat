import { t, useLocale, localized } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import type { AgentInput } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { appStore, refreshAgents, toast, toastError } from "../lib/app-state";
import { fileToBase64 } from "../lib/format";
import { linkClick, navigate, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, Modal } from "../lib/ui";

export function defaultAgentInput(name: string): AgentInput {
  return {
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: "",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        tags: [],
        creator: "",
        character_version: "",
        extensions: {}
      }
    },
    execution: {
      modelId: null,
      visionModelId: null,
      search: { provider: "searxng", baseUrl: "" },
      contextPolicy: "auto",
      reasoningEffort: "medium",
      generation: {},
      tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} },
      enabledSkillIds: [],
      maxToolRounds: 32,
      maxBackgroundTasks: 2,
      taskLogLimitBytes: 64 * 1024 * 1024
    },
    userProfile: {}
  };
}

let listPosition = { query: "", page: 1 };
export function AgentsView() {
  useLocale();
  const agents = useStore(appStore, (s) => s.agents);
  const models = useStore(appStore, (s) => s.models);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(listPosition.query);
  const [page, setPage] = useState(listPosition.page);
  const filtered = agents.filter((agent) => `${agent.name}\n${agent.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  useEffect(() => { if (!window.matchMedia("(pointer: coarse)").matches) searchInput.current?.focus(); }, []);
  useEffect(() => { listPosition = { query, page: currentPage }; }, [query, currentPage]);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const agent = await endpoints.createAgent(defaultAgentInput(newName.trim()));
      await refreshAgents();
      setCreating(false);
      setNewName("");
      navigate(routes.agents(agent.id));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const importCard = async (file: File) => {
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      const agent = await endpoints.importAgent(file.name, dataBase64);
      await refreshAgents();
      toast("success", localized("AgentsView.imported", { value1: (agent.name) }));
      navigate(routes.agents(agent.id));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await endpoints.deleteAgent(deleting);
      await refreshAgents();
      setDeleting(null);
      toast("success", localized("AgentsView.agent_deleted"));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-header mobile-redundant-title">
        <h2>Agent</h2>
        <div className="actions">
          <input
            ref={fileInput}
            type="file"
            accept=".json,.png,.charx,application/json,image/png,application/zip"
            className="sr-only"
            aria-label={t("AgentsView.choose_character_card_file")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importCard(file);
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>{t("AgentsView.import_character_card")}</button>
          <button
            className="btn primary"
            onClick={() => {
              setNewName("");
              setCreating(true);
            }}
          >{t("AgentsView.new_agent")}</button>
        </div>
      </div>
      <div className="panel-scroll">
        <div className="panel-inner agent-directory">
          <input ref={searchInput} className="input" type="search" aria-label={t("AgentsView.search_agent_list")} placeholder={t("AgentsView.search_agent_names_or_descriptions")} value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
          {agents.length === 0 ? (
            <EmptyState title={t("AgentsView.no_agents_yet")} hint={t("AgentsView.create_an_agent_or_import_a_character_card_json_png")} />
          ) : (
            visible.map((agent) => (
              <div key={agent.id} className="list-row agent-list-row">
                <a
                  className="agent-card-main"
                  href={routes.agents(agent.id)}
                  onClick={linkClick(routes.agents(agent.id))}
                  aria-label={t("SettingsView.edit_2", { value1: (agent.name) })}
                >
                  <div className="agent-list-content">
                    {agent.hasAvatar ? (
                      <img className="avatar-img" src={`/api/agents/${agent.id}/avatar`} alt="" />
                    ) : (
                      <span className="avatar-placeholder" aria-hidden="true">
                        {agent.name.slice(0, 1)}
                      </span>
                    )}
                    <div className="grow">
                    <div className="list-row-title">
                      <strong className="agent-name-button">{agent.name}</strong>
                      {agent.protected ? <span className="tag accent">{t("SettingsView.built_in")}</span> : null}
                      <span className="tag">{t("AgentsView.revision_v", { value1: (agent.revision) })}</span>
                    </div>
                    <div className="sub">
                      {agent.description
                        ? agent.description.slice(0, 120)
                        : models.find((m) => m.id === agent.modelId)?.displayName ?? t("AgentsView.no_model_configured")}
                    </div>
                  </div>
                  </div>
                </a>
                <div className="list-row-actions">
                  <a className="btn small" href={`/api/agents/${agent.id}/export?format=json`} download>{t("AgentsView.export_json")}</a>
                  <a className="btn small" href={`/api/agents/${agent.id}/export?format=png`} download>{t("AgentsView.export_png")}</a>
                  {agent.roleplayEnabled ? (
                    <a className="btn small" href={`/api/agents/${agent.id}/export?format=charx`} download>{t("AgentsView.export_charx")}</a>
                  ) : null}
                  {!agent.protected ? (
                    <button className="btn small danger" onClick={() => setDeleting(agent.id)}>{t("WorkspaceSidebar.delete_2")}</button>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {agents.length > 0 && !filtered.length ? <p className="hint">{t("AgentsView.no_matching_agents")}</p> : null}
          <nav className="list-pagination" aria-label={t("AgentsView.agent_pagination")}><span>{t("AgentsView.agents", { value1: (filtered.length), value2: (currentPage), value3: (pages) })}</span>
            <button className="btn small" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t("AgentsView.previous_page")}</button>
            <button className="btn small" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>{t("AgentsView.next_page")}</button></nav>
        </div>
      </div>
      {creating ? (
        <Modal
          title={t("AgentsView.new_agent")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>{t("WorkspaceSidebar.cancel")}</button>
              <button className="btn primary" disabled={busy || !newName.trim()} onClick={() => void create()}>{t("AgentsView.create")}</button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-agent-name">{t("SettingsView.name")}</label>
            <input
              id="new-agent-name"
              className="input"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
              }}
            />
          </div>
        </Modal>
      ) : null}
      {deleting ? (
        <ConfirmModal
          title={t("AgentsView.delete_agent")}
          message={t("AgentsView.conversations_using_this_agent_will_remain_but_you_must_select")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
          danger
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}
