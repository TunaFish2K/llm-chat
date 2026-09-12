import { toolLabel, toolDescription, toolError, skillName, skillDescription } from "../lib/catalog-i18n";
import { useErrorState, displayError } from "../lib/error-display";
import { LanguagePicker } from "../components/LanguagePicker";
import { t, useLocale, localized } from "../lib/i18n";
import { OfflineHistorySettings } from "../components/OfflineHistorySettings";
import { NotificationSettings } from "../components/NotificationSettings";
import { stopNotificationSession } from "../lib/notifications";
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

function getSECTIONS(): Array<[string, string]> { return [
  ["general", t("SettingsView.general")],
  ["security", t("SettingsView.security")],
  ["connections", t("SettingsView.connections_and_models")],
  ["search", t("SettingsView.search_engines")],
  ["image-generation", t("SettingsView.image_generation")],
  ["tools", t("SettingsView.tools")],
  ["skills", "Skill"],
  ["plugins", "Plugin"],
  ["mcp", "MCP"],
  ["memories", t("SettingsView.memory")]
]; }


function useResourceEvents(resources: string[], load: () => Promise<void>): void {
  useLocale();
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
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const active = getSECTIONS().some(([key]) => key === section) ? section : "general";
  return (
    <>
      <div className="page-header mobile-redundant-title settings-page-title">
        <h2>{t("WorkspaceSidebar.settings")}</h2>
      </div>
      <div className="tabs" role="tablist" aria-label={t("SettingsView.settings_sections")}>
        {getSECTIONS().map(([key, label]) => (
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
        <div className="panel-scroll"><div className="panel-inner"><p className="hint">{t("SettingsView.connect_to_view_and_change_these_settings")}</p></div></div>
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
  useLocale();
  return <div>
    <ServiceSettingsPanel kind="image" />
    <div className="card">
      <p className="hint">{t("SettingsView.generating_images_directly_in_responses_requires_image_output_support_the")}</p>
      <a className="btn" href={routes.settings("connections")} onClick={linkClick(routes.settings("connections"))}>{t("SettingsView.configure_connections_and_models")}</a>
    </div>
  </div>;
}
function AppUpdateCard() {
  useLocale();
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  const busy = ["checking", "downloading", "applying"].includes(pwa.updateStatus);
  const status = {
    idle: t("SettingsView.check_for_a_newer_version_of_the_app_on_this"),
    checking: t("SettingsView.checking_for_updates"),
    downloading: t("SettingsView.downloading_the_new_version"),
    current: t("SettingsView.up_to_date"),
    ready: t("SettingsView.the_new_version_is_ready_updating_will_refresh_this_page"),
    applying: t("SettingsView.applying_the_new_version"),
    error: pwa.updateError ? displayError({ message: pwa.updateError, ...(pwa.updateErrorI18n ? { i18n: pwa.updateErrorI18n } : {}) }) : t("SettingsView.update_failed_try_again")
  }[pwa.updateStatus];
  return <div className="card" aria-label={t("SettingsView.app_updates")}>
    <h3>{t("SettingsView.app_updates")}</h3>
    {pwa.supported ? <>
      <p className="hint" role={pwa.updateStatus === "error" ? "alert" : "status"}>{status}</p>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => void checkForUpdates()}>{t("SettingsView.check_for_updates")}</button>
        {pwa.updateAvailable ? <button type="button" className="btn primary" disabled={busy} onClick={() => void applyUpdate()}>{t("SettingsView.update_and_refresh")}</button> : null}
      </div>
    </> : <>
      <p className="hint">{t("SettingsView.this_browser_does_not_support_app_updates_refresh_to_get")}</p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>{t("SettingsView.refresh_page")}</button>
    </>}
  </div>;
}

function GeneralSection() {
  useLocale();
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
        toast("success", localized("SettingsView.settings_saved"));
      }
    }).catch((error) => { toastError(error); if (revision === patchVersion.current) void refreshSettings().catch(toastError); });
  };

  return (
    <div>
      <div className="card"><LanguagePicker /></div>
      <OfflineHistorySettings />
      <NotificationSettings />
      <fieldset disabled={offline} className="offline-settings-fields">
      <div className="card">
        <h3>{t("SettingsView.appearance_and_interaction")}</h3>
        <Field label={t("SettingsView.theme")}>
          <select
            className="select"
            aria-label={t("SettingsView.theme")}
            value={settings.theme}
            onChange={(event) => patch({ theme: event.target.value as AppSettings["theme"] })}
          >
            <option value="system">{t("SettingsView.follow_system")}</option>
            <option value="light">{t("SettingsView.light")}</option>
            <option value="dark">{t("SettingsView.dark")}</option>
          </select>
        </Field>
        <AccentPicker value={settings.uiPreferences.accentColor ?? null} onChange={(accentColor) => patch({ uiPreferences: { accentColor } })} />
        <label className="checkbox-row"><input type="checkbox" checked={settings.uiPreferences.amoled ?? false}
          onChange={(event) => patch({ uiPreferences: { amoled: event.target.checked } })} />{t("SettingsView.use_a_pure_black_background_in_dark_mode")}</label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.uiPreferences.sidebarCollapsed}
            onChange={(event) =>
              patch({ uiPreferences: { sidebarCollapsed: event.target.checked } })
            }
          />{t("SettingsView.collapse_the_sidebar_by_default")}</label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.uiPreferences.generationHaptics}
            onChange={(event) => patch({
              uiPreferences: { generationHaptics: event.target.checked }
            })}
          />
          <span className="haptics-label">
            <span>{t("SettingsView.vibrate_during_generation")}</span>
            {!hapticsSupported ? <small className="unsupported-hint">{t("SettingsView.this_browser_does_not_support_vibration")}</small> : null}
          </span>
        </label>
        <Field label={t("SettingsView.reasoning_collapse_behavior")}>
          <select
            className="select"
            aria-label={t("SettingsView.reasoning_collapse_behavior")}
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
            <option value="always-collapsed">{t("SettingsView.always_collapsed")}</option>
            <option value="collapse-on-answer">{t("SettingsView.collapse_when_the_answer_starts")}</option>
            <option value="never-auto-collapse">{t("SettingsView.never_collapse_automatically")}</option>
          </select>
        </Field>
      </div>

      </fieldset>
      <div className="card"><h3>{t("SettingsView.chat_typography")}</h3><ChatTypographySettings preview /></div>
      <fieldset disabled={offline} className="offline-settings-fields">
      <AppUpdateCard />
      <div className="card"><h3>{t("SettingsView.quick_tour")}</h3><p className="hint">{t("SettingsView.tour_progress_is_saved_only_in_this_browser_and_does")}</p>
        <button className="btn" onClick={() => window.dispatchEvent(new Event("llm-chat:quick-tour"))}>{t("SettingsView.replay_quick_tour")}</button></div>

      <div className="card">
        <h3>{t("SettingsView.default_agent")}</h3>
        <Field label={t("SettingsView.default_agent")}>
          <select className="select" aria-label={t("SettingsView.default_agent")} value={settings.defaultAgentId}
            onChange={(event) => patch({ defaultAgentId: event.target.value })}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <p className="hint">{t("SettingsView.configure_models_context_reasoning_and_system_prompts_in_agent_settings")}</p>
        <a className="btn" href={routes.agents(settings.defaultAgentId)}
          onClick={linkClick(routes.agents(settings.defaultAgentId))}>{t("SettingsView.edit_this_agent")}</a>
      </div>

      <div className="card">
        <h3>{t("SettingsView.user_profile")}</h3>
        <Field label={t("SettingsView.display_name")}>
          <input
            className="input"
            aria-label={t("SettingsView.user_display_name")}
            defaultValue={settings.userProfile.displayName}
            onBlur={(event) => {
              if (event.target.value !== settings.userProfile.displayName) {
                patch({ userProfile: { ...settings.userProfile, displayName: event.target.value } });
              }
            }}
          />
        </Field>
        <Field label={t("SettingsView.description")}>
          <ExpandableTextarea
            label={t("SettingsView.user_description")}
            value={settings.userProfile.description}
            onChange={(value) => patch({ userProfile: { ...settings.userProfile, description: value } })}
          />
        </Field>
      </div>

      <div className="card">
        <h3>{t("SettingsView.working_directory")}</h3>
        <p className="small muted mono">{settings.lastWorkspacePath ?? t("SettingsView.not_set")}</p>
        <button className="btn" onClick={() => setPickingWorkspace(true)}>{t("SettingsView.choose_working_directory")}</button>
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
  useLocale();
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
      setMessage(t("SettingsView.password_updated_revoked_previous_sessions", { value1: (result.sessionsRevoked) }));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await stopNotificationSession();
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
        <h3>{t("SettingsView.change_access_password")}</h3>
        <Field label={t("SettingsView.new_password")} hint={t("SettingsView.at_least_8_characters_changing_the_password_revokes_all_previous")} htmlFor="new-password">
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label={t("SettingsView.confirm_new_password")} htmlFor="confirm-password">
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
          <p role="alert" className="small" style={{ color: "var(--danger)" }}>{t("SettingsView.the_passwords_do_not_match")}</p>
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
        >{t("SettingsView.change_password")}</button>
      </div>
      <div className="card">
        <h3>{t("SettingsView.sign_out")}</h3>
        <p className="small muted">{t("SettingsView.you_will_need_the_access_password_to_sign_in_again")}</p>
        <button className="btn danger" disabled={busy} onClick={() => void logout()}>{t("SettingsView.sign_out")}</button>
      </div>
    </div>
  );
}

/* ---------- tools ---------- */

function getCATEGORY_LABELS(): Record<string, string> { return {
  web: t("SettingsView.web"),
  local: t("SettingsView.local"),
  workspace: t("SettingsView.workspace"),
  memory: t("SettingsView.memory"),
  conversation: t("SettingsView.conversation"),
  skill: "Skill",
  mcp: "MCP",
  background: t("SettingsView.background"),
  plugin: "Plugin",
  app: t("SettingsView.app_management")
}; }

function ToolsSection() {
  useLocale();
  const [settings, setSettings] = useState<ToolSettingsDto | null>(null);
  const [catalog, setCatalog] = useState<ToolCatalogItemDto[]>([]);
  const [error, setError] = useErrorState(null);
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
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_load"));
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
        <h3>{t("SettingsView.tool_environment")}</h3>
        <div className="environment-value">
          <span>{t("SettingsView.workspace_2")}</span>
          <OverflowText
            text={settings.workspacePath}
            label={t("SettingsView.view_full_workspace_path")}
            className="mono"
            onOpen={() => setDetail({ kind: "text", title: t("SettingsView.workspace_path"), text: settings.workspacePath })}
          />
        </div>
        <div className="environment-value">
          <span>{t("SettingsView.skill_directory")}</span>
          <OverflowText
            text={settings.skillsPath}
            label={t("SettingsView.view_full_skill_directory_path")}
            className="mono"
            onOpen={() => setDetail({ kind: "text", title: t("SettingsView.skill_directory_path"), text: settings.skillsPath })}
          />
        </div>
        <Switch
          label={t("SettingsView.enable_workspace_shell_tools")}
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
        <h3>{t("SettingsView.tool_catalog")}</h3>
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
              <th>{t("SettingsView.tools")}</th>
              <th>{t("SettingsView.category")}</th>
              <th>{t("SettingsView.source")}</th>
              <th>{t("SettingsView.approval")}</th>
              <th>{t("TasksView.status")}</th>
              <th>{t("SettingsView.enable")}</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((tool) => {
              const source = tool.sourceName ?? tool.sourceKind ?? t("SettingsView.built_in");
              return (
                <tr key={tool.name}>
                  <td className="tool-summary-cell">
                    <button
                      type="button"
                      className="catalog-summary-trigger"
                      aria-label={t("SettingsView.view_full_details_for_tool", { value1: (toolLabel(tool)) })}
                      aria-haspopup="dialog"
                      onClick={() => setDetail({ kind: "tool", tool })}
                    >
                      <span className="catalog-summary-label">{toolLabel(tool)}</span>
                      <span className="catalog-summary-id mono">{tool.name}</span>
                      <span className="catalog-summary-description">{toolDescription(tool) || t("SettingsView.no_description")}</span>
                      <Maximize2 className="catalog-summary-icon" size={13} aria-hidden="true" />
                    </button>
                  </td>
                  <td className="tool-meta-cell" data-label={t("SettingsView.category")}>
                    {getCATEGORY_LABELS()[tool.category] ?? tool.category}
                  </td>
                  <td className="tool-meta-cell" data-label={t("SettingsView.source")}>
                    <OverflowText
                      text={source}
                      label={t("SettingsView.view_full_source_for_tool", { value1: (toolLabel(tool)) })}
                      onOpen={() => setDetail({ kind: "tool", tool })}
                    />
                    {tool.revision ? <span className="tool-revision mono">{tool.revision.slice(0, 10)}</span> : null}
                  </td>
                  <td className="tool-meta-cell" data-label={t("SettingsView.approval")}>
                    {toolApprovalLabel(tool)}
                  </td>
                  <td className="tool-meta-cell" data-label={t("TasksView.status")}>
                    {tool.operationalState === "error" ? (
                      <span className="tag err" title={toolError(tool) ?? ""}>{t("SettingsView.error")}</span>
                    ) : tool.available ? (
                      <span className="tag ok">{t("SettingsView.available")}</span>
                    ) : (
                      <span className="tag">{t("SettingsView.unavailable")}</span>
                    )}
                  </td>
                  <td className="tool-meta-cell" data-label={t("SettingsView.enable")}>
                    <Switch
                      label={t("SettingsView.enable_tool", { value1: (toolLabel(tool)) })}
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
  return tool.approvalMode === "always" ? t("SettingsView.always_ask") : tool.approvalMode === "never" ? t("SettingsView.no_approval") : t("SettingsView.dynamic");
}

function ToolDetailModal({ tool, onClose }: { tool: ToolCatalogItemDto; onClose: () => void }) {
  useLocale();
  const source = tool.sourceName ?? tool.sourceKind ?? t("SettingsView.built_in");
  const state = tool.operationalState === "error" ? t("SettingsView.error") : tool.available ? t("SettingsView.available") : t("SettingsView.unavailable");
  return (
    <Modal title={t("SettingsView.tool_details", { value1: (toolLabel(tool)) })} onClose={onClose} wide>
      <dl className="catalog-detail-grid">
        <div><dt>{t("SettingsView.tool_id")}</dt><dd className="mono">{tool.name}</dd></div>
        <div><dt>{t("SettingsView.category")}</dt><dd>{getCATEGORY_LABELS()[tool.category] ?? tool.category}</dd></div>
        <div><dt>{t("SettingsView.source")}</dt><dd>{source}</dd></div>
        <div><dt>{t("SettingsView.approval")}</dt><dd>{toolApprovalLabel(tool)}</dd></div>
        <div><dt>{t("TasksView.status")}</dt><dd>{state}</dd></div>
        {tool.sourceId ? <div><dt>{t("SettingsView.source_id")}</dt><dd className="mono">{tool.sourceId}</dd></div> : null}
        {tool.revision ? <div><dt>{t("SettingsView.revision")}</dt><dd className="mono">{tool.revision}</dd></div> : null}
      </dl>
      <section className="catalog-detail-section">
        <h4>{t("SettingsView.description")}</h4>
        <p>{toolDescription(tool) || t("SettingsView.no_description")}</p>
      </section>
      {toolError(tool) ? (
        <section className="catalog-detail-section danger-text">
          <h4>{t("SettingsView.error")}</h4>
          <p>{toolError(tool)}</p>
        </section>
      ) : null}
    </Modal>
  );
}

function TextDetailModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  useLocale();
  return (
    <Modal title={title} onClose={onClose}>
      <p className="catalog-detail-text mono">{text}</p>
    </Modal>
  );
}

/* ---------- skills ---------- */

function SkillsSection() {
  useLocale();
  const [skills, setSkills] = useState<SkillDto[] | null>(null);
  const [error, setError] = useErrorState(null);
  const [installPath, setInstallPath] = useState("");
  const [inspecting, setInspecting] = useState<SkillDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSkills(await endpoints.skills());
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_load"));
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
        <h3>{t("SettingsView.install_and_discover")}</h3>
        <div className="row">
          <input
            className="input mono"
            style={{ flex: 1 }}
            placeholder={t("SettingsView.skill_directory_path_on_the_server")}
            aria-label={t("SettingsView.skill_installation_path")}
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
                  toast("success", localized("SettingsView.skill_installed"));
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >{t("SettingsView.install")}</button>
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
                    t("SettingsView.discovered_updated_unloaded_errors", { value1: (summary.discovered), value2: (summary.updated), value3: (summary.unloaded), value4: (summary.errors.length) })
                  );
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >{t("SettingsView.rediscover")}</button>
        </div>
      </div>
      {skills.length === 0 ? (
        <EmptyState title={t("SettingsView.no_skills")} hint={t("SettingsView.install_a_skill_directory_or_run_discovery_again")} />
      ) : (
        skills.map((skill) => (
          <div className="list-row" key={skill.id}>
            <div className="list-row-content">
              <div className="list-row-title">
                <strong>{skillName(skill)}</strong>
                <SkillStateTag state={skill.state} />
                {skill.bundled ? <span className="tag accent">{t("SettingsView.built_in")}</span> : null}
                <span className="tag mono">{skill.revision.slice(0, 10)}</span>
              </div>
              <button
                type="button"
                className="skill-summary-trigger"
                aria-label={t("SettingsView.view_full_details_for_skill", { value1: (skillName(skill)) })}
                aria-haspopup="dialog"
                onClick={() => setInspecting(skill)}
              >
                <span className="skill-description-summary">{skillDescription(skill) || t("SettingsView.no_description")}</span>
                {skill.error ? <span className="skill-error-summary">{skill.error}</span> : null}
                {skill.requiredTools.length > 0 ? (
                  <span className="skill-tools-summary">{t("SettingsView.required_tools", { value1: (skill.requiredTools.join(", ")) })}</span>
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
                      toast("success", localized("SettingsView.reloaded"));
                      await load();
                    })
                    .catch(toastError)
                    .finally(() => setBusy(false));
                }}
              >{t("SettingsView.reload")}</button>
            </div>
          </div>
        ))
      )}
      {inspecting ? <SkillDetailModal skill={inspecting} onClose={() => setInspecting(null)} /> : null}
    </div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: SkillDto; onClose: () => void }) {
  useLocale();
  return (
    <Modal title={t("SettingsView.skill_details", { value1: (skillName(skill)) })} onClose={onClose} wide>
      <dl className="catalog-detail-grid">
        <div><dt>{t("TasksView.status")}</dt><dd>{skillStateLabel(skill.state)}</dd></div>
        <div><dt>{t("SettingsView.source")}</dt><dd>{skill.bundled ? t("SettingsView.built_in") : t("SettingsView.installed")}</dd></div>
        <div><dt>{t("SettingsView.revision")}</dt><dd className="mono">{skill.revision}</dd></div>
        <div className="detail-grid-wide"><dt>{t("SettingsView.source_directory")}</dt><dd className="mono">{skill.sourcePath}</dd></div>
      </dl>
      <section className="catalog-detail-section">
        <h4>{t("SettingsView.description")}</h4>
        <p>{skillDescription(skill) || t("SettingsView.no_description")}</p>
      </section>
      <section className="catalog-detail-section">
        <h4>{t("SettingsView.required_tools_2")}</h4>
        {skill.requiredTools.length > 0 ? (
          <div className="catalog-detail-tools">
            {skill.requiredTools.map((tool) => <code key={tool}>{tool}</code>)}
          </div>
        ) : <p className="muted">{t("SettingsView.none")}</p>}
      </section>
      {skill.error ? (
        <section className="catalog-detail-section danger-text">
          <h4>{t("SettingsView.error")}</h4>
          <p>{skill.error}</p>
        </section>
      ) : null}
    </Modal>
  );
}

function skillStateLabel(state: SkillDto["state"]): string {
  return {
    loaded: t("SettingsView.loaded"),
    "pending-reload": t("SettingsView.reload_pending"),
    error: t("SettingsView.error"),
    unloaded: t("SettingsView.unloaded")
  }[state];
}

function SkillStateTag({ state }: { state: SkillDto["state"] }) {
  useLocale();
  const kind = state === "loaded" ? "ok" : state === "error" ? "err" : "warn";
  return <span className={`tag ${kind}`}>{skillStateLabel(state)}</span>;
}

/* ---------- plugins ---------- */

function PluginsSection() {
  useLocale();
  const [plugins, setPlugins] = useState<PluginDto[] | null>(null);
  const [error, setError] = useErrorState(null);
  const [installPath, setInstallPath] = useState("");
  const [configuring, setConfiguring] = useState<PluginDto | null>(null);
  const [removing, setRemoving] = useState<PluginDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlugins(await endpoints.plugins());
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_load"));
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
        <h3>{t("SettingsView.install_plugin")}</h3>
        <div className="row">
          <input
            className="input mono"
            style={{ flex: 1 }}
            placeholder={t("SettingsView.plugin_directory_path_on_the_server")}
            aria-label={t("SettingsView.plugin_installation_path")}
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
                  toast("success", localized("SettingsView.plugin_installed"));
                  await load();
                })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >{t("SettingsView.install")}</button>
        </div>
      </div>
      {plugins.length === 0 ? (
        <EmptyState title={t("SettingsView.no_plugins")} hint={t("SettingsView.install_a_server_managed_plugin_directory")} />
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
              <button className="btn small" onClick={() => setConfiguring(plugin)}>{t("SettingsView.configure")}</button>
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
              >{t("SettingsView.reload_2")}</button>
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
                >{t("SettingsView.unload")}</button>
              ) : null}
              <button className="btn small danger" onClick={() => setRemoving(plugin)}>{t("WorkspaceSidebar.delete_2")}</button>
            </div>
          </div>
        ))
      )}
      {configuring ? (
        <PluginConfigModal plugin={configuring} onClose={() => setConfiguring(null)} onSaved={load} />
      ) : null}
      {removing ? (
        <ConfirmModal
          title={t("SettingsView.delete_plugin", { value1: (removing.manifest.name) })}
          message={t("SettingsView.its_registered_tools_will_no_longer_be_available")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
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
  useLocale();
  const [configText, setConfigText] = useState(() => JSON.stringify(plugin.config, null, 2));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useErrorState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configText || "{}") as Record<string, unknown>;
    } catch {
      setError(localized("SettingsView.configuration_is_not_valid_json"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.configurePlugin(plugin.id, config, secrets);
      await onSaved();
      toast("success", localized("SettingsView.plugin_configuration_saved"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("SettingsView.configure_2", { value1: (plugin.manifest.name) })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t("WorkspaceSidebar.cancel")}</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{t("WorkspaceSidebar.save")}</button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <Field label={t("SettingsView.configuration_json")}>
        <textarea
          className="textarea mono"
          rows={8}
          aria-label={t("SettingsView.plugin_configuration_json")}
          value={configText}
          onChange={(event) => setConfigText(event.target.value)}
        />
      </Field>
      {plugin.manifest.secretFields.length > 0 ? (
        <Field
          label={t("SettingsView.secret_fields")}
          hint={
            plugin.configuredSecretFields.length > 0
              ? t("SettingsView.configured_leave_blank_to_keep_existing_values", { value1: (plugin.configuredSecretFields.join(", ")) })
              : t("SettingsView.only_nonempty_fields_are_saved")
          }
        >
          {plugin.manifest.secretFields.map((field) => (
            <input
              key={field}
              className="input mono"
              type="password"
              style={{ marginBottom: 6 }}
              placeholder={field}
              aria-label={t("SettingsView.secret_field", { value1: (field) })}
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
  useLocale();
  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [error, setError] = useErrorState(null);
  const [editing, setEditing] = useState<McpServerDto | "new" | null>(null);
  const [removing, setRemoving] = useState<McpServerDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setServers(await endpoints.mcpServers());
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_load"));
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
        <h3 className="section-heading-actions">{t("SettingsView.mcp_servers")}<button className="btn small primary" onClick={() => setEditing("new")}>{t("SettingsView.add_server")}</button>
        </h3>
        {servers.length === 0 ? (
          <EmptyState title={t("SettingsView.no_mcp_servers")} hint={t("SettingsView.add_a_remote_mcp_server_to_extend_the_tool_catalog")} />
        ) : (
          servers.map((server) => (
            <div className="list-row" key={server.id}>
              <div className="list-row-content">
                <div className="list-row-title">
                  <strong>{server.name}</strong>
                  {server.enabled ? <span className="tag ok">{t("SettingsView.enabled")}</span> : <span className="tag">{t("SettingsView.disabled")}</span>}
                </div>
                <div className="sub mono">{server.url}</div>
                {server.headerNames.length > 0 ? <div className="sub">{t("SettingsView.headers", { value1: (server.headerNames.join(", ")) })}</div> : null}
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
                        if (result.ok) toast("success", localized("SettingsView.connected", { value1: (result.tools !== undefined ? t("detail.tools", { value1: (result.tools) }) : "") }));
                        else toast("error", result.error ?? t("SettingsView.connection_failed"));
                      })
                      .catch(toastError)
                      .finally(() => setBusy(false));
                  }}
                >{t("SettingsView.test")}</button>
                <button className="btn small" onClick={() => setEditing(server)}>{t("SettingsView.edit")}</button>
                <button className="btn small danger" onClick={() => setRemoving(server)}>{t("WorkspaceSidebar.delete_2")}</button>
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
          title={t("SettingsView.delete_mcp_server", { value1: (removing.name) })}
          message={t("SettingsView.tools_provided_by_this_server_will_no_longer_be_available")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
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
  useLocale();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [error, setError] = useErrorState(null);
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
      toast("success", localized("SettingsView.mcp_server_saved"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={server ? t("SettingsView.edit_2", { value1: (server.name) }) : t("SettingsView.add_mcp_server")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t("WorkspaceSidebar.cancel")}</button>
          <button className="btn primary" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>{t("WorkspaceSidebar.save")}</button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <div className="grid-2">
        <Field label={t("SettingsView.name")} hint={t("SettingsView.use_only_english_letters_and_numbers")} htmlFor="mcp-name">
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
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("SettingsView.enable")}</label>
      <Field
        label={t("SettingsView.headers_2")}
        hint={
          server && server.headerNames.length > 0
            ? t("SettingsView.currently_configured_leave_blank_to_keep_existing_values", { value1: (server.headerNames.join(", ")) })
            : undefined
        }
      >
        {headers.map((header, index) => (
          <div className="row" key={index} style={{ marginBottom: 6 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder={t("SettingsView.header_name")}
              aria-label={t("SettingsView.header_name_2", { value1: (index + 1) })}
              value={header.name}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))
              }
            />
            <input
              className="input mono"
              style={{ flex: 2 }}
              placeholder={t("SettingsView.value")}
              aria-label={t("SettingsView.header_value", { value1: (index + 1) })}
              value={header.value}
              onChange={(event) =>
                setHeaders(headers.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))
              }
            />
            <button className="btn small" onClick={() => setHeaders(headers.filter((_, i) => i !== index))}>{t("SettingsView.remove")}</button>
          </div>
        ))}
        <button className="btn small" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>{t("SettingsView.add_header")}</button>
      </Field>
    </Modal>
  );
}

/* ---------- memories ---------- */

function MemoriesSection() {
  useLocale();
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useErrorState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMemories(await endpoints.memories());
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_load"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!memories) return <LoadingState />;

  return (
    <div className="card">
      <h3>{t("SettingsView.long_term_memory")}</h3>
      <p className="small muted">{t("SettingsView.the_model_writes_memories_using_the_memory_tool_this_view")}</p>
      {memories.length === 0 ? (
        <EmptyState title={t("SettingsView.no_memories_yet")} />
      ) : (
        memories.map((memory) => (
          <div className="list-row" key={memory.id}>
            <div className="grow">
              <div style={{ whiteSpace: "pre-wrap" }}>{memory.content}</div>
              <div className="sub">{t("SettingsView.updated", { value1: (formatTime(memory.updatedAt)) })}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
