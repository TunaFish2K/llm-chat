import { ActionButton } from "../lib/action-feedback";
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
      appStore.set((state) => ({ agents: [...state.agents.filter((item) => item.id !== agent.id), agent] }));
      void refreshAgents().catch(toastError);
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
      appStore.set((state) => ({ agents: [...state.agents.filter((item) => item.id !== agent.id), agent] }));
      void refreshAgents().catch(toastError);
      toast("success", `已导入 ${agent.name}`);
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
      appStore.set((state) => ({ agents: state.agents.filter((item) => item.id !== deleting) }));
      void refreshAgents().catch(toastError);
      setDeleting(null);
      toast("success", "已删除 Agent");
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
            aria-label="选择角色卡文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importCard(file);
            }}
          />
          <ActionButton className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
            导入角色卡
          </ActionButton>
          <ActionButton
            className="btn primary"
            onClick={() => {
              setNewName("");
              setCreating(true);
            }}
          >
            新建 Agent
          </ActionButton>
        </div>
      </div>
      <div className="panel-scroll">
        <div className="panel-inner agent-directory">
          <input ref={searchInput} className="input" type="search" aria-label="搜索 Agent 列表" placeholder="搜索 Agent 名称或描述" value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
          {agents.length === 0 ? (
            <EmptyState title="还没有 Agent" hint="新建一个 Agent 或导入 Character Card（JSON / PNG）。" />
          ) : (
            visible.map((agent) => (
              <div key={agent.id} className="list-row agent-list-row">
                <a
                  className="agent-card-main"
                  href={routes.agents(agent.id)}
                  onClick={linkClick(routes.agents(agent.id))}
                  aria-label={`编辑 ${agent.name}`}
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
                      {agent.protected ? <span className="tag accent">内置</span> : null}
                      <span className="tag">修订 v{agent.revision}</span>
                    </div>
                    <div className="sub">
                      {agent.description
                        ? agent.description.slice(0, 120)
                        : models.find((m) => m.id === agent.modelId)?.displayName ?? "未设置模型"}
                    </div>
                  </div>
                  </div>
                </a>
                <div className="list-row-actions">
                  <a className="btn small" href={`/api/agents/${agent.id}/export?format=json`} download>
                    导出 JSON
                  </a>
                  <a className="btn small" href={`/api/agents/${agent.id}/export?format=png`} download>
                    导出 PNG
                  </a>
                  {agent.roleplayEnabled ? (
                    <a className="btn small" href={`/api/agents/${agent.id}/export?format=charx`} download>
                      导出 CHARX
                    </a>
                  ) : null}
                  {!agent.protected ? (
                    <ActionButton className="btn small danger" onClick={() => setDeleting(agent.id)}>
                      删除
                    </ActionButton>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {agents.length > 0 && !filtered.length ? <p className="hint">没有匹配的 Agent。</p> : null}
          <nav className="list-pagination" aria-label="Agent 分页"><span>{filtered.length} 个 Agent · {currentPage} / {pages}</span>
            <ActionButton className="btn small" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</ActionButton>
            <ActionButton className="btn small" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</ActionButton></nav>
        </div>
      </div>
      {creating ? (
        <Modal
          title="新建 Agent"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ActionButton className="btn" onClick={() => setCreating(false)}>
                取消
              </ActionButton>
              <ActionButton className="btn primary" disabled={busy || !newName.trim()} onClick={() => create()}>
                创建
              </ActionButton>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-agent-name">名称</label>
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
          title="删除 Agent"
          message="删除后引用该 Agent 的会话会保留，但必须重新选择 Agent 才能继续生成。"
          confirmLabel="删除"
          danger
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove()}
        />
      ) : null}
    </>
  );
}
