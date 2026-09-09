import { OfflineHistorySettings } from "../components/OfflineHistorySettings";
import { clearOfflineHistory, offlineStore } from "../lib/offline-history";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2 } from "lucide-react";
import type {
  AppSettings,
  McpServerDto,
  PluginDto,
  SkillDto,
  ToolCatalogItemDto,
  ToolSettingsDto
} from "@llm-chat/contracts";
import { endpoints, type MemoryDto as MemoryItem } from "../lib/api";
import { ChatTypographySettings } from "../components/ChatTypographySettings";
import { AccentPicker } from "../components/AccentPicker";
import {
  appStore,
  acceptSettings,
  updateUiPreferences,
  refreshSettings,
  toast,
  toastError
} from "../lib/app-state";
import { formatTime } from "../lib/format";
import {
  generationHapticsSupported
} from "../lib/haptics";
import { linkClick, routes } from "../lib/router";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, ErrorState, Field, LoadingState, Modal, Switch } from "../lib/ui";
import { ConnectionsView } from "./ConnectionsView";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { OverflowText } from "../components/OverflowText";
import { ExpandableTextarea } from "../components/ExpandableTextarea";
import { applyUpdate, checkForUpdates, getPwaState, subscribePwa } from "../lib/pwa";
import { ServiceSettingsPanel } from "../components/ServiceSettingsPanel";

const SECTIONS: Array<[string, string]> = [
  ["general", "通用"],
  ["security", "安全"],
  ["connections", "连接与模型"],
  ["search", "搜索引擎"],
  ["image-generation", "图片生成"],
  ["tools", "工具"],
  ["skills", "Skill"],
  ["plugins", "Plugin"],
  ["mcp", "MCP"],
  ["memories", "记忆"]
];


function useResourceEvents(resources: string[], load: () => Promise<void>): void {
  useEffect(() => {
    const listener = (raw: Event) => {
      const resource = (raw as CustomEvent<{ resource?: string }>).detail?.resource;
      if (resource && resources.includes(resource)) void load();
    };
    window.addEventListener("llm-chat:resource-changed", listener);
    return () => window.removeEventListener("llm-chat:resource-changed", listener);
  }, [load, resources.join("\0")]);
}

export function SettingsView({ section }: { section: string }) {
  const offline = useStore(offlineStore, (state) => state.offline);
  const active = SECTIONS.some(([key]) => key === section) ? section : "general";
  return (
    <>
      <div className="page-header mobile-redundant-title settings-page-title">
        <h2>设置</h2>
      </div>
      <div className="tabs" role="tablist" aria-label="设置分区">
        {SECTIONS.map(([key, label]) => (
          <a
            key={key}
            role="tab"
            aria-selected={active === key}
            className={active === key ? "active" : ""}
            href={routes.settings(key)}
            onClick={linkClick(routes.settings(key))}
          >
            {label}
          </a>
        ))}
      </div>
      {offline && !["general", "security"].includes(active) ? (
        <div className="panel-scroll"><div className="panel-inner"><p className="hint">此设置需要联网后查看和修改。</p></div></div>
      ) : active === "connections" ? (
        <ConnectionsView embedded />
      ) : (
        <div className="panel-scroll">
          <div className="panel-inner">
            {active === "general" ? <GeneralSection /> : null}
            {active === "search" ? <ServiceSettingsPanel kind="search" /> : null}
            {active === "security" ? <SecuritySection /> : null}
            {active === "image-generation" ? <ImageGenerationSection /> : null}
            {active === "tools" ? <ToolsSection /> : null}
            {active === "skills" ? <SkillsSection /> : null}
            {active === "plugins" ? <PluginsSection /> : null}
            {active === "mcp" ? <McpSection /> : null}
            {active === "memories" ? <MemoriesSection /> : null}
          </div>
        </div>
      )}
    </>
  );
}

function ImageGenerationSection() {
  return <div>
    <ServiceSettingsPanel kind="image" />
    <div className="card">
      <p className="hint">直接通过 Responses 对话生图需要模型启用图片输出；工具生图还需要配置图片协议。</p>
      <a className="btn" href={routes.settings("connections")} onClick={linkClick(routes.settings("connections"))}>配置连接与模型</a>
    </div>
  </div>;
}
function AppUpdateCard() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  const busy = ["checking", "downloading", "applying"].includes(pwa.updateStatus);
  const status = {
    idle: "检查此设备上的应用是否有新版本。",
    checking: "正在检查更新…",
    downloading: "正在下载新版本…",
    current: "已是最新版本",
    ready: "新版本已准备好，更新后将刷新当前页面。",
    applying: "正在启用新版本…",
    error: pwa.updateError ?? "更新失败，请重试"
  }[pwa.updateStatus];
  return <div className="card" aria-label="应用更新">
    <h3>应用更新</h3>
    {pwa.supported ? <>
      <p className="hint" role={pwa.updateStatus === "error" ? "alert" : "status"}>{status}</p>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => void checkForUpdates()}>检查更新</button>
        {pwa.updateAvailable ? <button type="button" className="btn primary" disabled={busy} onClick={() => void applyUpdate()}>更新并刷新</button> : null}
      </div>
    </> : <>
      <p className="hint">当前浏览器不支持应用更新，可以刷新页面获取服务器上的版本。</p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>刷新页面</button>
    </>}
  </div>;
}

function GeneralSection() {
  const offline = useStore(offlineStore, (state) => state.offline);
  const settings = useStore(appStore, (s) => s.settings);
  const agents = useStore(appStore, (s) => s.agents);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const hapticsSupported = generationHapticsSupported();
  const patchSequence = useRef(Promise.resolve());
  const patchVersion = useRef(0);

  if (!settings) return <LoadingState />;

  const patch = (value: Omit<Partial<AppSettings>, "uiPreferences"> & { uiPreferences?: Partial<AppSettings["uiPreferences"]> }) => {
    if (value.uiPreferences) { updateUiPreferences(value.uiPreferences); return; }
    const revision = ++patchVersion.current;
    const current = appStore.get().settings ?? settings;
    const { uiPreferences: _preferences, ...fields } = value;
    appStore.set({ settings: { ...current, ...fields } });
    patchSequence.current = patchSequence.current.then(async () => {
      await endpoints.updateSettings(value);
      if (revision !== patchVersion.current) return;
      const saved = await endpoints.settings();
      if (revision === patchVersion.current) {
        acceptSettings(saved);
        toast("success", "设置已保存");
      }
    }).catch((error) => { toastError(error); if (revision === patchVersion.current) void refreshSettings().catch(toastError); });
  };

  return (
    <div>
      <OfflineHistorySettings />
      <fieldset disabled={offline} className="offline-settings-fields">
      <div className="card">
        <h3>外观与交互</h3>
        <Field label="主题">
          <select
            className="select"
            aria-label="主题"
            value={settings.theme}
            onChange={(event) => patch({ theme: event.target.value as AppSettings["theme"] })}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Field>
        <AccentPicker value={settings.uiPreferences.accentColor ?? null} onChange={(accentColor) => patch({ uiPreferences: { accentColor } })} />
        <label className="checkbox-row"><input type="checkbox" checked={settings.uiPreferences.amoled ?? false}
          onChange={(event) => patch({ uiPreferences: { amoled: event.target.checked } })} />深色模式使用纯黑背景</label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.uiPreferences.sidebarCollapsed}
            onChange={(event) =>
              patch({ uiPreferences: { sidebarCollapsed: event.target.checked } })
            }
          />
          默认折叠侧边栏
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.uiPreferences.generationHaptics}
            onChange={(event) => patch({
              uiPreferences: { generationHaptics: event.target.checked }
            })}
          />
          <span className="haptics-label">
            <span>生成时振动</span>
            {!hapticsSupported ? <small className="unsupported-hint">当前浏览器不支持振动</small> : null}
          </span>
        </label>
        <Field label="推理块折叠策略">
          <select
            className="select"
            aria-label="推理块折叠策略"
            value={settings.uiPreferences.reasoningCollapsePolicy}
            onChange={(event) =>
              patch({
                uiPreferences: {
                  reasoningCollapsePolicy: event.target
                    .value as AppSettings["uiPreferences"]["reasoningCollapsePolicy"]
                }
              })
            }
          >
            <option value="always-collapsed">总是折叠</option>
            <option value="collapse-on-answer">正文出现后折叠</option>
            <option value="never-auto-collapse">从不自动折叠</option>
          </select>
        </Field>
      </div>

      <div className="card"><h3>聊天排版</h3><ChatTypographySettings preview /></div>
      <AppUpdateCard />
      <div className="card"><h3>快速教程</h3><p className="hint">教程观看状态只保存在当前浏览器，不同步到其他设备。</p>
        <button className="btn" onClick={() => window.dispatchEvent(new Event("llm-chat:quick-tour"))}>重放快速教程</button></div>

      <div className="card">
        <h3>默认 Agent</h3>
        <Field label="默认 Agent">
          <select className="select" aria-label="默认 Agent" value={settings.defaultAgentId}
            onChange={(event) => patch({ defaultAgentId: event.target.value })}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <p className="hint">模型、上下文、推理档位和系统提示在 Agent 中设置。</p>
        <a className="btn" href={routes.agents(settings.defaultAgentId)}
          onClick={linkClick(routes.agents(settings.defaultAgentId))}>编辑此 Agent</a>
      </div>

      <div className="card">
        <h3>用户画像</h3>
        <Field label="显示名">
          <input
            className="input"
            aria-label="用户显示名"
            defaultValue={settings.userProfile.displayName}
            onBlur={(event) => {
              if (event.target.value !== settings.userProfile.displayName) {
                patch({ userProfile: { ...settings.userProfile, displayName: event.target.value } });
              }
            }}
          />
        </Field>
        <Field label="描述">
          <ExpandableTextarea
            label="用户描述"
            value={settings.userProfile.description}
            onChange={(value) => patch({ userProfile: { ...settings.userProfile, description: value } })}
          />
        </Field>
      </div>

      <div className="card">
        <h3>工作目录</h3>
        <p className="small muted mono">{settings.lastWorkspacePath ?? "（未设置）"}</p>
        <button className="btn" onClick={() => setPickingWorkspace(true)}>
          选择工作目录
        </button>
      </div>

      {pickingWorkspace ? (
        <DirectoryPicker
          initialPath={settings.lastWorkspacePath}
          onClose={() => setPickingWorkspace(false)}
          onSelect={(path) => {
            setPickingWorkspace(false);
            patch({ lastWorkspacePath: path });
          }}
        />
      ) : null}
      </fieldset>
    </div>
  );
}

/* ---------- security ---------- */

function SecuritySection() {
  const offline = useStore(offlineStore, (state) => state.offline);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const changePassword = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await endpoints.changePassword(password);
      setPassword("");
      setConfirm("");
      setMessage(`密码已更新，已撤销 ${result.sessionsRevoked} 个旧会话。`);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await clearOfflineHistory({ logout: true });
      await endpoints.logout();
      window.location.reload();
    } catch (error) {
      toastError(error);
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>修改访问密码</h3>
        <Field label="新密码" hint="至少 8 个字符。修改后所有旧会话都会被撤销。" htmlFor="new-password">
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="确认新密码" htmlFor="confirm-password">
          <input
            id="confirm-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {password && confirm && password !== confirm ? (
          <p role="alert" className="small" style={{ color: "var(--danger)" }}>
            两次输入的密码不一致。
          </p>
        ) : null}
        {message ? (
          <p role="status" className="small" style={{ color: "var(--success)" }}>
            {message}
          </p>
        ) : null}
        <button
          className="btn primary"
          disabled={offline || busy || password.length < 8 || password !== confirm}
          onClick={() => void changePassword()}
        >
          修改密码
        </button>
      </div>
      <div className="card">
        <h3>退出登录</h3>
        <p className="small muted">退出后需要重新输入访问密码。</p>
        <button className="btn danger" disabled={busy} onClick={() => void logout()}>
          退出登录
        </button>
      </div>
    </div>
  );
}

/* ---------- tools ---------- */

const CATEGORY_LABELS: Record<string, string> = {
  web: "网络",
  local: "本地",
  workspace: "工作区",
  memory: "记忆",
  conversation: "会话",
  skill: "Skill",
  mcp: "MCP",
  background: "后台",
  plugin: "Plugin",
  app: "网站管理"
};

function ToolsSection() {
  const [settings, setSettings] = useState<ToolSettingsDto | null>(null);
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<
    { kind: "tool"; tool: ToolCatalogItemDto } | { kind: "text"; title: string; text: string } | null
  >(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [toolSettings, items] = await Promise.all([endpoints.toolSettings(), endpoints.toolCatalog()]);
      setSettings(toolSettings);
      setCatalog(items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useResourceEvents(["tools", "plugins", "skills", "mcp"], load);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!settings) return <LoadingState />;

  const toggleTool = (name: string, enabled: boolean) => {
    const next = { ...settings.enabled, [name]: enabled };
    setSettings({ ...settings, enabled: next });
    endpoints
      .updateToolSettings({ enabled: { [name]: enabled } })
      .catch((cause) => {
        toastError(cause);
        void load();
      });
  };

  return (
    <div>
      <div className="card">
        <h3>工具环境</h3>
        <div className="environment-value">
          <span>工作区：</span>
          <OverflowText
            text={settings.workspacePath}
            label="查看完整工作区路径"
            className="mono"
            onOpen={() => setDetail({ kind: "text", title: "工作区路径", text: settings.workspacePath })}
          />
        </div>
        <div className="environment-value">
          <span>Skill 目录：</span>
          <OverflowText
            text={settings.skillsPath}
            label="查看完整 Skill 目录路径"
            className="mono"
            onOpen={() => setDetail({ kind: "text", title: "Skill 目录路径", text: settings.skillsPath })}
          />
        </div>
        <Switch
          label="启用工作区 Shell 工具"
          checked={settings.workspaceShellEnabled}
          onChange={(checked) => {
              setSettings({ ...settings, workspaceShellEnabled: checked });
              endpoints
                .updateToolSettings({ workspaceShellEnabled: checked })
                .catch((cause) => {
                  toastError(cause);
                  void load();
                });
          }}
        />
      </div>

      <div className="card">
        <h3>工具目录</h3>
        <table className="table tool-catalog-table">
          <colgroup>
            <col className="tool-col-main" />
            <col className="tool-col-category" />
            <col className="tool-col-source" />
            <col className="tool-col-approval" />
            <col className="tool-col-state" />
            <col className="tool-col-enabled" />
          </colgroup>
          <thead>
            <tr>
              <th>工具</th>
              <th>分类</th>
              <th>来源</th>
              <th>审批</th>
              <th>状态</th>
              <th>启用</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((tool) => {
              const source = tool.sourceName ?? tool.sourceKind ?? "内置";
              return (
                <tr key={tool.name}>
                  <td className="tool-summary-cell">
                    <button
                      type="button"
                      className="catalog-summary-trigger"
                      aria-label={`查看工具 ${tool.label} 的完整信息`}
                      aria-haspopup="dialog"
                      onClick={() => setDetail({ kind: "tool", tool })}
                    >
                      <span className="catalog-summary-label">{tool.label}</span>
                      <span className="catalog-summary-id mono">{tool.name}</span>
                      <span className="catalog-summary-description">{tool.description || "无描述"}</span>
                      <Maximize2 className="catalog-summary-icon" size={13} aria-hidden="true" />
                    </button>
                  </td>
                  <td className="tool-meta-cell" data-label="分类">
                    {CATEGORY_LABELS[tool.category] ?? tool.category}
                  </td>
                  <td className="tool-meta-cell" data-label="来源">
                    <OverflowText
                      text={source}
                      label={`查看工具 ${tool.label} 的完整来源`}
                      onOpen={() => setDetail({ kind: "tool", tool })}
                    />
                    {tool.revision ? <span className="tool-revision mono">{tool.revision.slice(0, 10)}</span> : null}
                  </td>
                  <td className="tool-meta-cell" data-label="审批">
                    {toolApprovalLabel(tool)}
                  </td>
                  <td className="tool-meta-cell" data-label="状态">
                    {tool.operationalState === "error" ? (
                      <span className="tag err" title={tool.error ?? ""}>
                        错误
                      </span>
                    ) : tool.available ? (
                      <span className="tag ok">可用</span>
                    ) : (
                      <span className="tag">不可用</span>
                    )}
                  </td>
                  <td className="tool-meta-cell" data-label="启用">
                    <Switch
                      label={`启用工具 ${tool.label}`}
                      hideLabel
                      checked={settings.enabled[tool.name] ?? true}
                      disabled={!tool.available}
                      onChange={(checked) => toggleTool(tool.name, checked)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail?.kind === "tool" ? (
        <ToolDetailModal tool={detail.tool} onClose={() => setDetail(null)} />
      ) : detail?.kind === "text" ? (
        <TextDetailModal title={detail.title} text={detail.text} onClose={() => setDetail(null)} />
      ) : null}
    </div>
  );
}

function toolApprovalLabel(tool: ToolCatalogItemDto): string {
  return tool.approvalMode === "always" ? "每次审批" : tool.approvalMode === "never" ? "免审批" : "动态";
}

function ToolDetailModal({ tool, onClose }: { tool: ToolCatalogItemDto; onClose: () => void }) {
  const source = tool.sourceName ?? tool.sourceKind ?? "内置";
  const state = tool.operationalState === "error" ? "错误" : tool.available ? "可用" : "不可用";
  return (
    <Modal title={`工具详情 · ${tool.label}`} onClose={onClose} wide>
      <dl className="catalog-detail-grid">
        <div><dt>工具 ID</dt><dd className="mono">{tool.name}</dd></div>
        <div><dt>分类</dt><dd>{CATEGORY_LABELS[tool.category] ?? tool.category}</dd></div>
        <div><dt>来源</dt><dd>{source}</dd></div>
        <div><dt>审批</dt><dd>{toolApprovalLabel(tool)}</dd></div>
        <div><dt>状态</dt><dd>{state}</dd></div>
        {tool.sourceId ? <div><dt>来源 ID</dt><dd className="mono">{tool.sourceId}</dd></div> : null}
        {tool.revision ? <div><dt>修订</dt><dd className="mono">{tool.revision}</dd></div> : null}
      </dl>
      <section className="catalog-detail-section">
        <h4>描述</h4>
        <p>{tool.description || "无描述"}</p>
      </section>
      {tool.error ? (
        <section className="catalog-detail-section danger-text">
          <h4>错误</h4>
          <p>{tool.error}</p>
        </section>
      ) : null}
    </Modal>
  );
}

function TextDetailModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="catalog-detail-text mono">{text}</p>
    </Modal>
  );
}

/* ---------- skills ---------- */

function SkillsSection() {
  const [skills, setSkills] = useState<SkillDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [inspecting, setInspecting] = useState<SkillDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSkills(await endpoints.skills());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useResourceEvents(["skills"], load);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!skills) return <LoadingState />;

  return (
    <div>
      <div className="card">
        <h3>安装与发现</h3>
        <div className="row">
          <input
            className="input mono"
            style={{ flex: 1 }}
            placeholder="服务端上的 Skill 目录路径"
            aria-label="Skill 安装路径"
            value={installPath}
            onChange={(event) => setInstallPath(event.target.value)}
          />
          <button
            className="btn"
            disabled={busy || !installPath.trim()}
            onClick={() => {
              setBusy(true);
              endpoints
                .installSkill(installPath.trim())
                .then(async () => {
                  setInstallPath("");
                  toast("success", "Skill 已安装");
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >
            安装
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              endpoints
                .discoverSkills()
                .then(async (summary) => {
                  toast(
                    "success",
                    `发现 ${summary.discovered}，更新 ${summary.updated}，卸载 ${summary.unloaded}，错误 ${summary.errors.length}`
                  );
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >
            重新发现
          </button>
        </div>
      </div>
      {skills.length === 0 ? (
        <EmptyState title="没有 Skill" hint="安装一个 Skill 目录，或运行重新发现。" />
      ) : (
        skills.map((skill) => (
          <div className="list-row" key={skill.id}>
            <div className="list-row-content">
              <div className="list-row-title">
                <strong>{skill.name}</strong>
                <SkillStateTag state={skill.state} />
                {skill.bundled ? <span className="tag accent">内置</span> : null}
                <span className="tag mono">{skill.revision.slice(0, 10)}</span>
              </div>
              <button
                type="button"
                className="skill-summary-trigger"
                aria-label={`查看 Skill ${skill.name} 的完整信息`}
                aria-haspopup="dialog"
                onClick={() => setInspecting(skill)}
              >
                <span className="skill-description-summary">{skill.description || "无描述"}</span>
                {skill.error ? <span className="skill-error-summary">{skill.error}</span> : null}
                {skill.requiredTools.length > 0 ? (
                  <span className="skill-tools-summary">依赖工具：{skill.requiredTools.join(", ")}</span>
                ) : null}
                <Maximize2 className="skill-summary-icon" size={13} aria-hidden="true" />
              </button>
            </div>
            <div className="list-row-actions">
              <button
                className="btn small"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  endpoints
                    .reloadSkill(skill.id)
                    .then(async () => {
                      toast("success", "已重新加载");
                      await load();
                    })
                    .catch(toastError)
                    .finally(() => setBusy(false));
                }}
              >
                重新加载
              </button>
            </div>
          </div>
        ))
      )}
      {inspecting ? <SkillDetailModal skill={inspecting} onClose={() => setInspecting(null)} /> : null}
    </div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: SkillDto; onClose: () => void }) {
  return (
    <Modal title={`Skill 详情 · ${skill.name}`} onClose={onClose} wide>
      <dl className="catalog-detail-grid">
        <div><dt>状态</dt><dd>{skillStateLabel(skill.state)}</dd></div>
        <div><dt>来源</dt><dd>{skill.bundled ? "内置" : "已安装"}</dd></div>
        <div><dt>修订</dt><dd className="mono">{skill.revision}</dd></div>
        <div className="detail-grid-wide"><dt>源目录</dt><dd className="mono">{skill.sourcePath}</dd></div>
      </dl>
      <section className="catalog-detail-section">
        <h4>描述</h4>
        <p>{skill.description || "无描述"}</p>
      </section>
      <section className="catalog-detail-section">
        <h4>依赖工具</h4>
        {skill.requiredTools.length > 0 ? (
          <div className="catalog-detail-tools">
            {skill.requiredTools.map((tool) => <code key={tool}>{tool}</code>)}
          </div>
        ) : <p className="muted">无</p>}
      </section>
      {skill.error ? (
        <section className="catalog-detail-section danger-text">
          <h4>错误</h4>
          <p>{skill.error}</p>
        </section>
      ) : null}
    </Modal>
  );
}

function skillStateLabel(state: SkillDto["state"]): string {
  return {
    loaded: "已加载",
    "pending-reload": "待重载",
    error: "错误",
    unloaded: "已卸载"
  }[state];
}

function SkillStateTag({ state }: { state: SkillDto["state"] }) {
  const kind = state === "loaded" ? "ok" : state === "error" ? "err" : "warn";
  return <span className={`tag ${kind}`}>{skillStateLabel(state)}</span>;
}

/* ---------- plugins ---------- */

function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [configuring, setConfiguring] = useState<PluginDto | null>(null);
  const [removing, setRemoving] = useState<PluginDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlugins(await endpoints.plugins());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useResourceEvents(["plugins"], load);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!plugins) return <LoadingState />;

  return (
    <div>
      <div className="card">
        <h3>安装 Plugin</h3>
        <div className="row">
          <input
            className="input mono"
            style={{ flex: 1 }}
            placeholder="服务端上的 Plugin 目录路径"
            aria-label="Plugin 安装路径"
            value={installPath}
            onChange={(event) => setInstallPath(event.target.value)}
          />
          <button
            className="btn primary"
            disabled={busy || !installPath.trim()}
            onClick={() => {
              setBusy(true);
              endpoints
                .installPlugin(installPath.trim())
                .then(async () => {
                  setInstallPath("");
                  toast("success", "Plugin 已安装");
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >
            安装
          </button>
        </div>
      </div>
      {plugins.length === 0 ? (
        <EmptyState title="没有 Plugin" hint="安装一个服务端托管的 Plugin 目录。" />
      ) : (
        plugins.map((plugin) => (
          <div className="list-row" key={plugin.id}>
            <div className="list-row-content">
              <div className="list-row-title">
                <strong>{plugin.manifest.name}</strong>
                <SkillStateTag state={plugin.state} />
                <span className="tag mono">v{plugin.manifest.version}</span>
                <span className="tag mono">{plugin.revision.slice(0, 10)}</span>
              </div>
              <div className="sub">{plugin.manifest.description}</div>
              {plugin.error ? <div className="sub" style={{ color: "var(--danger)" }}>{plugin.error}</div> : null}
            </div>
            <div className="list-row-actions">
              <button className="btn small" onClick={() => setConfiguring(plugin)}>
                配置
              </button>
              <button
                className="btn small"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  endpoints
                    .reloadPlugin(plugin.id)
                    .then(load)
                    .catch(toastError)
                    .finally(() => setBusy(false));
                }}
              >
                重载
              </button>
              {plugin.state !== "unloaded" ? (
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    endpoints
                      .unloadPlugin(plugin.id)
                      .then(load)
                      .catch(toastError)
                      .finally(() => setBusy(false));
                  }}
                >
                  卸载
                </button>
              ) : null}
              <button className="btn small danger" onClick={() => setRemoving(plugin)}>
                删除
              </button>
            </div>
          </div>
        ))
      )}
      {configuring ? (
        <PluginConfigModal plugin={configuring} onClose={() => setConfiguring(null)} onSaved={load} />
      ) : null}
      {removing ? (
        <ConfirmModal
          title={`删除 Plugin ${removing.manifest.name}`}
          message="删除后其注册的工具将不可用。"
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            endpoints
              .removePlugin(target.id)
              .then(load)
              .catch(toastError);
          }}
        />
      ) : null}
    </div>
  );
}

function PluginConfigModal({
  plugin,
  onClose,
  onSaved
}: {
  plugin: PluginDto;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [configText, setConfigText] = useState(() => JSON.stringify(plugin.config, null, 2));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configText || "{}") as Record<string, unknown>;
    } catch {
      setError("配置不是有效的 JSON");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.configurePlugin(plugin.id, config, secrets);
      await onSaved();
      toast("success", "Plugin 配置已保存");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`配置 ${plugin.manifest.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <Field label="配置（JSON）">
        <textarea
          className="textarea mono"
          rows={8}
          aria-label="Plugin 配置 JSON"
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
        />
      </Field>
      {plugin.manifest.secretFields.length > 0 ? (
        <Field
          label="秘密字段"
          hint={
            plugin.configuredSecretFields.length > 0
              ? `已配置：${plugin.configuredSecretFields.join(", ")}。留空保持不变。`
              : "只写入非空字段。"
          }
        >
          {plugin.manifest.secretFields.map((field) => (
            <input
              key={field}
              className="input mono"
              type="password"
              style={{ marginBottom: 6 }}
              placeholder={field}
              aria-label={`秘密字段 ${field}`}
              value={secrets[field] ?? ""}
              onChange={(event) => setSecrets({ ...secrets, [field]: event.target.value })}
            />
          ))}
        </Field>
      ) : null}
    </Modal>
  );
}

/* ---------- MCP ---------- */

function McpSection() {
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerDto | "new" | null>(null);
  const [removing, setRemoving] = useState<McpServerDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setServers(await endpoints.mcpServers());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useResourceEvents(["mcp"], load);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!servers) return <LoadingState />;

  return (
    <div>
      <div className="card">
        <h3 className="section-heading-actions">
          MCP 服务
          <button className="btn small primary" onClick={() => setEditing("new")}>
            添加服务
          </button>
        </h3>
        {servers.length === 0 ? (
          <EmptyState title="没有 MCP 服务" hint="添加一个远程 MCP 服务以扩展工具目录。" />
        ) : (
          servers.map((server) => (
            <div className="list-row" key={server.id}>
              <div className="list-row-content">
                <div className="list-row-title">
                  <strong>{server.name}</strong>
                  {server.enabled ? <span className="tag ok">已启用</span> : <span className="tag">已停用</span>}
                </div>
                <div className="sub mono">{server.url}</div>
                {server.headerNames.length > 0 ? <div className="sub">请求头：{server.headerNames.join(", ")}</div> : null}
                {server.lastError ? <div className="sub" style={{ color: "var(--danger)" }}>{server.lastError}</div> : null}
              </div>
              <div className="list-row-actions">
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    endpoints
                      .testMcpServer(server.id)
                      .then((result) => {
                        if (result.ok) toast("success", `连接正常${result.tools !== undefined ? `，${result.tools} 个工具` : ""}`);
                        else toast("error", result.error ?? "连接失败");
                      })
                      .catch(toastError)
                      .finally(() => setBusy(false));
                  }}
                >
                  测试
                </button>
                <button className="btn small" onClick={() => setEditing(server)}>
                  编辑
                </button>
                <button className="btn small danger" onClick={() => setRemoving(server)}>
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {editing ? (
        <McpEditor server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />
      ) : null}
      {removing ? (
        <ConfirmModal
          title={`删除 MCP 服务 ${removing.name}`}
          message="删除后该服务提供的工具将不可用。"
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            endpoints
              .deleteMcpServer(target.id)
              .then(load)
              .catch(toastError);
          }}
        />
      ) : null}
    </div>
  );
}

function McpEditor({
  server,
  onClose,
  onSaved
}: {
  server: McpServerDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const headerRecord: Record<string, string> = {};
      for (const header of headers) {
        if (header.name.trim()) headerRecord[header.name.trim()] = header.value;
      }
      if (server) {
        await endpoints.updateMcpServer(server.id, {
          name: name.trim(),
          url: url.trim(),
          enabled,
          ...(headers.length > 0 ? { headers: headerRecord } : {})
        });
      } else {
        await endpoints.createMcpServer({ name: name.trim(), url: url.trim(), enabled, headers: headerRecord });
      }
      await onSaved();
      toast("success", "MCP 服务已保存");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={server ? `编辑 ${server.name}` : "添加 MCP 服务"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <div className="grid-2">
        <Field label="名称" hint="只能包含英文字母和数字。" htmlFor="mcp-name">
          <input id="mcp-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="URL" htmlFor="mcp-url">
          <input
            id="mcp-url"
            className="input mono"
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        启用
      </label>
      <Field
        label="请求头"
        hint={
          server && server.headerNames.length > 0
            ? `当前已配置：${server.headerNames.join(", ")}。留空保持不变。`
            : undefined
        }
      >
        {headers.map((header, index) => (
          <div className="row" key={index} style={{ marginBottom: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder="Header 名称"
              aria-label={`请求头 ${index + 1} 名称`}
              value={header.name}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))
              }
            />
            <input
              className="input mono"
              style={{ flex: 2 }}
              placeholder="值"
              aria-label={`请求头 ${index + 1} 值`}
              value={header.value}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))
              }
            />
            <button className="btn small" onClick={() => setHeaders(headers.filter((_, i) => i !== index))}>
              移除
            </button>
          </div>
        ))}
        <button className="btn small" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
          添加请求头
        </button>
      </Field>
    </Modal>
  );
}

/* ---------- memories ---------- */

function MemoriesSection() {
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMemories(await endpoints.memories());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!memories) return <LoadingState />;

  return (
    <div className="card">
      <h3>长期记忆</h3>
      <p className="small muted">记忆由模型通过记忆工具写入，此处只读展示。</p>
      {memories.length === 0 ? (
        <EmptyState title="还没有记忆" />
      ) : (
        memories.map((memory) => (
          <div className="list-row" key={memory.id}>
            <div className="grow">
              <div style={{ whiteSpace: "pre-wrap" }}>{memory.content}</div>
              <div className="sub">更新于 {formatTime(memory.updatedAt)}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
