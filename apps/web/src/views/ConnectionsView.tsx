import { useErrorState } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { ModelBrandIcon } from "../components/chat/ModelBrandIcon";
import { Bot, Plus } from "lucide-react";
import type {
  ConnectionDto,
  ConnectionInput,
  ModelCapabilities,
  ModelDto,
  ModelInput,
  ProviderPresetId,
  ProviderProtocol
} from "@llm-chat/contracts";
import { providerPreset, providerPresetDefinitions, resolveModelProtocol } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { appStore, refreshConnectionsAndModels, toast, toastError } from "../lib/app-state";
import { formatTime, formatTokens } from "../lib/format";
import { useStore } from "../lib/store";
import { ConfirmModal, EmptyState, Field, Modal, Switch } from "../lib/ui";

interface BalanceState {
  loading: boolean;
  value?: number;
  cached?: boolean;
  fetchedAt?: number;
  error?: string;
}

export function ConnectionsView({ embedded = false }: { embedded?: boolean } = {}) {
  useLocale();
  const connections = useStore(appStore, (s) => s.connections);
  const models = useStore(appStore, (s) => s.models);
  const [editingConnection, setEditingConnection] = useState<ConnectionDto | "new" | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<ConnectionDto | null>(null);
  const [editingModel, setEditingModel] = useState<ModelDto | "new" | null>(null);
  const [newModelConnection, setNewModelConnection] = useState<string>();
  const [deletingModel, setDeletingModel] = useState<ModelDto | null>(null);
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const [busy, setBusy] = useState(false);

  const loadBalance = useCallback(async (connection: ConnectionDto, refresh = false) => {
    setBalances((current) => ({ ...current, [connection.id]: { loading: true } }));
    try {
      const result = await endpoints.connectionBalance(connection.id, refresh);
      setBalances((current) => ({
        ...current,
        [connection.id]: { loading: false, value: result.value, cached: result.cached, fetchedAt: result.fetchedAt }
      }));
    } catch (error) {
      setBalances((current) => ({
        ...current,
        [connection.id]: { loading: false, error: error instanceof Error ? error.message : t("ConnectionsView.could_not_retrieve_balance") }
      }));
    }
  }, []);

  useEffect(() => {
    for (const connection of connections) {
      if (connection.balanceConfig?.enabled && !balances[connection.id]) {
        void loadBalance(connection);
      }
    }
  }, [connections, balances, loadBalance]);

  const testConnection = async (connection: ConnectionDto) => {
    setBusy(true);
    try {
      const result = await endpoints.testConnection(connection.id);
      toast("success", localized("ConnectionsView.connected_found_models", { value1: (result.modelsFound) }));
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const discover = async (connection: ConnectionDto) => {
    setBusy(true);
    try {
      const result = await endpoints.discoverModels(connection.id);
      await refreshConnectionsAndModels();
      const details = [
        t("ConnectionsView.found", { value1: (result.discovered) }),
        t("ConnectionsView.added", { value1: (result.created.length) }),
        t("ConnectionsView.updated", { value1: (result.updated.length) }),
        t("ConnectionsView.kept_manual_settings_for", { value1: (result.skipped) }),
        t("ConnectionsView.unmatched_in_catalog", { value1: (result.unmatched) })
      ];
      toast(result.warnings.length > 0 ? "info" : "success", `${details.join("，")}。${result.warnings.join("；")}`);
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  };

  const actions = (
    <div className={embedded ? "connection-actions" : "actions"}>
      <button className="btn primary" onClick={() => setEditingConnection("new")}>
        <Plus size={15} aria-hidden="true" />{t("ConnectionsView.new_connection")}</button>
    </div>
  );

  return (
    <>
      {!embedded ? <div className="page-header">
        <h2>{t("SettingsView.connections_and_models")}</h2>
        {actions}
      </div> : null}
      <div className="panel-scroll">
        <div className="panel-inner">
          {embedded ? actions : null}
          {connections.length === 0 ? (
            <EmptyState title={t("ConnectionsView.no_connections_yet")} hint={t("ConnectionsView.add_a_model_provider_connection_then_discover_models_or_add")} />
          ) : (
            connections.map((connection) => {
              const balance = balances[connection.id];
              const connectionModels = models.filter((model) => model.connectionId === connection.id);
              return (
                <div className="card" key={connection.id}>
                  <header className="management-card-header">
                    <h3 className="list-row-title">
                      <strong>{connection.name}</strong>
                      <span className="tag">{providerPreset(connection.providerId).label}</span>
                      <span className="tag">{connection.protocol}</span>
                    </h3>
                    <div className="list-row-actions">
                      <button className="btn small" onClick={() => { setNewModelConnection(connection.id); setEditingModel("new"); }}>{t("ConnectionsView.add_model_manually")}</button>
                      <button className="btn small" disabled={busy} onClick={() => void testConnection(connection)}>{t("ConnectionsView.test_connection")}</button>
                      <button className="btn small" disabled={busy} onClick={() => void discover(connection)}>{t("ConnectionsView.discover_models")}</button>
                      <button className="btn small" onClick={() => setEditingConnection(connection)}>{t("SettingsView.edit")}</button>
                      <button className="btn small danger" onClick={() => setDeletingConnection(connection)}>{t("WorkspaceSidebar.delete_2")}</button>
                    </div>
                  </header>
                  <p className="small muted mono">{connection.baseUrl}</p>
                  <p className="small muted">
                    API Key：{connection.hasApiKey ? t("ConnectionsView.configured") : t("ConnectionsView.not_configured")}
                    {connection.secretHeaderNames.length > 0
                      ? t("ConnectionsView.secret_headers", { value1: (connection.secretHeaderNames.join(", ")) })
                      : ""}
                  </p>
                  {connection.balanceConfig?.enabled ? (
                    <p className="small">{(<>{t("ConnectionsView.balance", { value1: "" })}{(balance?.loading ? (
                        t("detail.checking")
                      ) : balance?.error ? (
                        <span style={{ color: "var(--danger)" }}>{balance.error}</span>
                      ) : balance?.value !== undefined ? (
                        <>
                          <strong>{balance.value}</strong>
                          {balance.cached ? t("detail.cached") : ""} · {formatTime(balance.fetchedAt)}
                        </>
                      ) : (
                        t("detail.not_checked")
                      ))}</>)}<button className="btn small ghost" onClick={() => void loadBalance(connection, true)}>{t("TasksView.refresh")}</button>
                    </p>
                  ) : null}

                  {connectionModels.length === 0 ? (
                    <p className="small muted">{t("ConnectionsView.this_connection_has_no_models")}</p>
                  ) : (
                    <table className="table connection-model-table">
                      <thead>
                        <tr>
                          <th>{t("InspectorPanel.model")}</th>
                          <th>{t("InspectorPanel.context")}</th>
                          <th>{t("SettingsView.source")}</th>
                          <th>{t("SettingsView.enable")}</th>
                          <th>{t("TasksView.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {connectionModels.map((model) => (
                          <tr key={model.id}>
                            <td className="connection-model-summary" data-label={t("InspectorPanel.model")}>
                              <div className="list-row-title">
                                <ModelBrandIcon model={model} connection={connection} />
                                <span>{model.displayName}</span>
                                {model.catalogManaged ? <span className="tag ok">{t("ConnectionsView.managed_automatically")}</span> : null}
                              </div>
                              <div className="small muted mono">{model.modelKey} · {resolveModelProtocol(model, connection)}</div>
                            </td>
                            <td className="connection-model-context" data-label={t("InspectorPanel.context")}>
                              <div>{formatTokens(model.contextWindow ?? undefined)}</div>
                              <div className="small muted">{t("ConnectionsView.input_output", { value1: (formatTokens(model.maxInputTokens ?? undefined)), value2: (formatTokens(model.maxOutputTokens)) })}</div>
                            </td>
                            <td className="connection-model-meta" data-label={t("SettingsView.source")}>{model.source === "discovered" ? t("ConnectionsView.discovered") : t("ConnectionsView.manual")}</td>
                            <td className="connection-model-meta connection-model-enabled" data-label={t("SettingsView.enable")}>
                              <Switch
                                label={t("ConnectionsView.enable", { value1: (model.displayName) })}
                                hideLabel
                                checked={model.enabled}
                                onChange={(checked) => {
                                  endpoints
                                    .updateModel(model.id, { enabled: checked })
                                    .then(() => refreshConnectionsAndModels())
                                    .catch(toastError);
                                }}
                              />
                            </td>
                            <td className="connection-model-actions" data-label={t("TasksView.actions")}>
                              <button className="btn small" onClick={() => setEditingModel(model)}>{t("SettingsView.edit")}</button>{" "}
                              <button className="btn small danger" onClick={() => setDeletingModel(model)}>{t("WorkspaceSidebar.delete_2")}</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {editingConnection ? (
        <ConnectionEditor
          connection={editingConnection === "new" ? null : editingConnection}
          onClose={() => setEditingConnection(null)}
        />
      ) : null}
      {editingModel ? (
        <ModelEditor
          model={editingModel === "new" ? null : editingModel}
          {...(newModelConnection ? { initialConnectionId: newModelConnection } : {})}
          onClose={() => setEditingModel(null)}
        />
      ) : null}
      {deletingConnection ? (
        <ConfirmModal
          title={t("ConnectionsView.delete_connection", { value1: (deletingConnection.name) })}
          message={t("ConnectionsView.deleting_this_connection_also_deletes_all_its_models_and_clears")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
          danger
          onClose={() => setDeletingConnection(null)}
          onConfirm={() => {
            const target = deletingConnection;
            setDeletingConnection(null);
            endpoints
              .deleteConnection(target.id)
              .then(() => refreshConnectionsAndModels())
              .catch(toastError);
          }}
        />
      ) : null}
      {deletingModel ? (
        <ConfirmModal
          title={t("ConnectionsView.delete_model", { value1: (deletingModel.displayName) })}
          message={t("ConnectionsView.delete_this_model")}
          confirmLabel={t("WorkspaceSidebar.delete_2")}
          danger
          onClose={() => setDeletingModel(null)}
          onConfirm={() => {
            const target = deletingModel;
            setDeletingModel(null);
            endpoints
              .deleteModel(target.id)
              .then(() => refreshConnectionsAndModels())
              .catch(toastError);
          }}
        />
      ) : null}
    </>
  );
}

function ConnectionEditor({ connection, onClose }: { connection: ConnectionDto | null; onClose: () => void }) {
  useLocale();
  const initialProviderId = connection?.providerId ?? "custom";
  const [providerId, setProviderId] = useState<ProviderPresetId>(initialProviderId);
  const [name, setName] = useState(connection?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(connection?.protocol ?? providerPreset(initialProviderId).defaultProtocol);
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [balanceEnabled, setBalanceEnabled] = useState(Boolean(connection?.balanceConfig?.enabled));
  const [balancePath, setBalancePath] = useState(connection?.balanceConfig?.apiPath ?? "");
  const [balanceExpression, setBalanceExpression] = useState(connection?.balanceConfig?.resultExpression ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useErrorState(null);
  const selectedProvider = providerPreset(providerId);

  const chooseProvider = (next: ProviderPresetId) => {
    const preset = providerPreset(next);
    setProviderId(next);
    if (next !== "custom") {
      if (!name.trim() || providerId === "custom") setName(preset.label);
      setBaseUrl(preset.baseUrl);
      setProtocol(preset.defaultProtocol);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const secretHeaders: Record<string, string> = {};
      for (const header of headers) {
        if (header.name.trim()) secretHeaders[header.name.trim()] = header.value;
      }
      let saved: ConnectionDto;
      if (connection) {
        const patch: Partial<ConnectionInput> = {
          name: name.trim(),
          providerId,
          protocol,
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          ...(headers.length > 0 ? { secretHeaders } : {}),
          ...(balanceEnabled
            ? {
                balanceConfig: {
                  enabled: true,
                  apiPath: balancePath.trim(),
                  resultExpression: balanceExpression.trim()
                }
              }
            : connection.balanceConfig
              ? { balanceConfig: { ...connection.balanceConfig, enabled: false } }
              : {})
        };
        saved = await endpoints.updateConnection(connection.id, patch);
      } else {
        const input: ConnectionInput = {
          name: name.trim(),
          providerId,
          protocol,
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          secretHeaders,
          ...(balanceEnabled
            ? {
                balanceConfig: {
                  enabled: true,
                  apiPath: balancePath.trim(),
                  resultExpression: balanceExpression.trim()
                }
              }
            : {})
        };
        saved = await endpoints.createConnection(input);
      }
      await refreshConnectionsAndModels();
      if (providerId !== "custom" && providerId !== "stability") {
        try {
          const result = await endpoints.discoverModels(saved.id);
          await refreshConnectionsAndModels();
          toast("success", localized("ConnectionsView.connection_saved_found_models_and_added", { value1: (result.discovered), value2: (result.created.length) }));
        } catch (cause) {
          toast("error", localized("ConnectionsView.connection_saved_but_model_discovery_failed", { value1: (cause instanceof Error ? cause.message : t("detail.request_failed")) }));
        }
      } else {
        toast("success", localized("ConnectionsView.connection_saved"));
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={connection ? t("ConnectionsView.edit_connection", { value1: (connection.name) }) : t("ConnectionsView.new_connection")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{t("WorkspaceSidebar.cancel")}</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !baseUrl.trim() || (providerId !== "custom" && !apiKey && !connection?.hasApiKey)}
            onClick={() => void save()}
          >{t("WorkspaceSidebar.save")}</button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      <Field label="Provider" hint={selectedProvider.description} htmlFor="conn-provider">
        <select
          id="conn-provider"
          className="select"
          value={providerId}
          onChange={(event) => chooseProvider(event.target.value as ProviderPresetId)}
        >
          {providerPresetDefinitions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid-2">
        <Field label={t("SettingsView.name")} htmlFor="conn-name">
          <input id="conn-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("InspectorPanel.protocol")} htmlFor="conn-protocol">
          <select
            id="conn-protocol"
            className="select"
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as ProviderProtocol)}
          >
            {selectedProvider.protocols.map((item) => (
              <option key={item} value={item}>
                {item === "openai-responses" ? "OpenAI Responses" : item === "openai-chat" ? "OpenAI Chat Completions" : "Anthropic Messages"}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Base URL" htmlFor="conn-base-url">
        <input
          id="conn-base-url"
          className="input mono"
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </Field>
      <Field
        label="API Key"
        hint={connection?.hasApiKey ? t("ConnectionsView.configured_leave_blank_to_keep_the_existing_value") : providerId === "custom" ? t("ConnectionsView.optional") : t("ConnectionsView.preset_providers_require_an_api_key")}
        htmlFor="conn-api-key"
      >
        <input
          id="conn-api-key"
          className="input mono"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      <Field
        label={t("ConnectionsView.secret_headers_2")}
        hint={
          connection && connection.secretHeaderNames.length > 0
            ? t("ConnectionsView.currently_configured_a_matching_header_name_replaces_its_value_leave", { value1: (connection.secretHeaderNames.join(", ")) })
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
      <label className="checkbox-row">
        <input type="checkbox" checked={balanceEnabled} onChange={(event) => setBalanceEnabled(event.target.checked)} />{t("ConnectionsView.enable_balance_lookup")}</label>
      {balanceEnabled ? (
        <div className="grid-2" style={{ marginTop: 8 }}>
          <Field label={t("ConnectionsView.balance_api_path")} hint={t("ConnectionsView.an_absolute_path_relative_to_the_connection_origin_such_as")}>
            <input
              className="input mono"
              aria-label={t("ConnectionsView.balance_api_path")}
              value={balancePath}
              onChange={(event) => setBalancePath(event.target.value)}
            />
          </Field>
          <Field label={t("ConnectionsView.value_expression")} hint={t("ConnectionsView.extract_the_balance_from_the_response_json")}>
            <input
              className="input mono"
              aria-label={t("ConnectionsView.value_expression")}
              value={balanceExpression}
              onChange={(event) => setBalanceExpression(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

type BooleanModelCapability = Exclude<keyof ModelCapabilities, "maxImageInputs">;

function getCAPABILITY_LABELS(): Array<[BooleanModelCapability, string]> { return [
  ["imageInput", t("ConnectionsView.image_input")],
  ["imageOutput", t("ConnectionsView.image_output")],
  ["imageEdit", t("ConnectionsView.image_editing")],
  ["imageInpaint", t("ConnectionsView.image_inpainting")],
  ["imageVariation", t("ConnectionsView.image_variations")],
  ["imageMultiple", t("ConnectionsView.multiple_image_outputs")],
  ["tools", t("SettingsView.tools")],
  ["temperature", t("ConnectionsView.temperature")],
  ["topP", "Top-P"],
  ["reasoning", t("TrajectoryView.reasoning")],
  ["reasoningSummary", t("ConnectionsView.reasoning_summary")],
  ["adaptiveThinking", t("ConnectionsView.adaptive_thinking")],
  ["manualThinking", t("ConnectionsView.manual_thinking")]
]; }

function ModelEditor({ model, onClose, initialConnectionId }: { model: ModelDto | null; onClose: () => void; initialConnectionId?: string }) {
  useLocale();
  const connections = useStore(appStore, (s) => s.connections);
  const [connectionId, setConnectionId] = useState(model?.connectionId ?? initialConnectionId ?? connections[0]?.id ?? "");
  const [modelKey, setModelKey] = useState(model?.modelKey ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol | null>(model?.protocol ?? null);
  const [reasoningManual, setReasoningManual] = useState(model?.reasoningEffortsOverride != null);
  const [reasoningValues, setReasoningValues] = useState((model?.reasoningEffortsOverride ?? model?.detectedReasoningEfforts ?? []).join("\n"));
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxInputTokens, setMaxInputTokens] = useState(model?.maxInputTokens?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(model?.maxOutputTokens ?? 4096));
  const [maxImageInputs, setMaxImageInputs] = useState(model?.capabilities.maxImageInputs?.toString() ?? "");
  const [imageProtocol, setImageProtocol] = useState<ModelInput["imageProtocol"]>(model?.imageProtocol ?? null);
  const selectedConnection = connections.find((connection) => connection.id === connectionId);
  const detectedProtocol = model?.connectionId === connectionId && model.modelKey === modelKey.trim() ? model.detectedProtocol : null;
  const effectiveProtocol = selectedConnection ? resolveModelProtocol({ modelKey: modelKey.trim(), protocol, detectedProtocol }, selectedConnection) : null;
  const supportedImageProtocols = providerPreset(selectedConnection?.providerId ?? "custom").imageProtocols;
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(
    model?.capabilities ?? {
      imageInput: false,
      tools: true,
      temperature: true,
      topP: true,
      reasoning: false,
      reasoningSummary: false,
      adaptiveThinking: false,
      manualThinking: false
    }
  );
  const [temperature, setTemperature] = useState(model?.defaultSettings.common.temperature?.toString() ?? "");
  const [reasoningSummary, setReasoningSummary] = useState(model?.defaultSettings.protocol.reasoningSummary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useErrorState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: ModelInput = {
        connectionId,
        modelKey: modelKey.trim(),
        protocol,
        reasoningEffortsOverride: reasoningManual ? [...new Set(reasoningValues.split(/\r?\n/).map(value => value.trim()).filter(Boolean))] : null,
        displayName: displayName.trim(),
        contextWindow: contextWindow === "" ? null : Number(contextWindow),
        maxInputTokens: maxInputTokens === "" ? null : Number(maxInputTokens),
        maxOutputTokens: Number(maxOutputTokens) || 4096,
        imageProtocol: imageProtocol ?? null,
        capabilities: {
          ...capabilities,
          ...(maxImageInputs === "" && model?.capabilities.maxImageInputs === undefined ? {} : { maxImageInputs: maxImageInputs === "" ? null : Number(maxImageInputs) })
        },
        defaultSettings: {
          common: {
            ...model?.defaultSettings.common,
            ...(temperature === "" ? {} : { temperature: Number(temperature) }),
            maxOutputTokens: Number(maxOutputTokens) || 4096,
            stopSequences: model?.defaultSettings.common.stopSequences ?? []
          },
          protocol: { ...model?.defaultSettings.protocol, ...(reasoningSummary ? { reasoningSummary: reasoningSummary as "auto" | "concise" | "detailed" } : {}) }
        },
        enabled: model?.enabled ?? true
      };
      if (temperature === "") delete input.defaultSettings.common.temperature;
      if (!reasoningSummary) delete input.defaultSettings.protocol.reasoningSummary;
      if (model) {
        // Preserve untouched defaults, including a generation limit different from the model limit.
        if (temperature === (model.defaultSettings.common.temperature?.toString() ?? "") &&
            reasoningSummary === (model.defaultSettings.protocol.reasoningSummary ?? "") &&
            maxOutputTokens === String(model.maxOutputTokens)) input.defaultSettings = model.defaultSettings;
        const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(model[key as keyof ModelInput] ?? null)
        ));
        await endpoints.updateModel(model.id, changes);
      }
      else await endpoints.createModel(input);
      await refreshConnectionsAndModels();
      toast("success", localized("ConnectionsView.model_saved"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("SettingsView.could_not_save"));
    } finally {
      setBusy(false);
    }
  };

  const restoreCatalog = async () => {
    if (!model) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.restoreModelCatalog(model.id);
      await refreshConnectionsAndModels();
      toast("success", localized("ConnectionsView.restored_catalog_management_and_refreshed_model_settings"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("ConnectionsView.could_not_restore_catalog_management"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={model ? t("ConnectionsView.edit_model", { value1: (model.displayName) }) : t("ConnectionsView.add_model_manually")}
      onClose={onClose}
      wide
      footer={
        <>
          {model && !model.catalogManaged ? (
            <button className="btn" disabled={busy} onClick={() => void restoreCatalog()}>{t("ConnectionsView.restore_catalog_management")}</button>
          ) : null}
          <button className="btn" onClick={onClose}>{t("WorkspaceSidebar.cancel")}</button>
          <button
            className="btn primary"
            disabled={busy || !modelKey.trim() || !displayName.trim() || !connectionId}
            onClick={() => void save()}
          >{t("WorkspaceSidebar.save")}</button>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {model ? (
        <div className="model-management-note" data-managed={model.catalogManaged || undefined}>
          <div>
            <strong>{model.catalogManaged ? t("ConnectionsView.manage_model_settings_automatically") : t("ConnectionsView.using_manual_settings")}</strong>
            <span>
              {model.catalogManaged
                ? model.catalogMetadata
                  ? t("ConnectionsView.settings_come_from_models_dev_saving_technical_settings_below_switches")
                  : t("ConnectionsView.no_catalog_match_yet_discovery_will_try_again_saving_settings")
                : model.catalogMetadata
                  ? t("ConnectionsView.restore_catalog_management_to_use_capabilities_limits_and_prices_from")
                  : t("ConnectionsView.this_model_has_no_matching_catalog_entry_yet")}
            </span>
          </div>
          <span className={`tag ${model.catalogManaged ? "ok" : ""}`}>{model.catalogManaged ? t("ConnectionsView.automatic") : t("ConnectionsView.manual")}</span>
        </div>
      ) : null}
      <div className="grid-2">
        <Field label={t("ConnectionsView.connection")}>
          <select
            className="select"
            aria-label={t("ConnectionsView.connection")}
            value={connectionId}
            onChange={(event) => {
              const nextConnectionId = event.target.value;
              setConnectionId(nextConnectionId);
              const nextProvider = providerPreset(connections.find((item) => item.id === nextConnectionId)?.providerId ?? "custom");
              if (protocol && !nextProvider.protocols.includes(protocol)) setProtocol(null);
              const protocols = providerPreset(connections.find((item) => item.id === nextConnectionId)?.providerId ?? "custom").imageProtocols;
              if (protocols.length && imageProtocol && !protocols.includes(imageProtocol)) {
                setImageProtocol(null);
                setCapabilities((current) => ({ ...current, imageOutput: false }));
              }
            }}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("SettingsView.display_name")}>
          <input
            className="input"
            aria-label={t("SettingsView.display_name")}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
      </div>
      <Field label={t("ConnectionsView.model_identifier_modelkey")}>
        <input
          className="input mono"
          aria-label={t("ConnectionsView.model_identifier")}
          value={modelKey}
          onChange={(event) => setModelKey(event.target.value)}
        />
      </Field>
      <Field label={t("reasoning.source")} hint={t("reasoning.source_hint")}>
        <select className="select" aria-label={t("reasoning.source")} value={reasoningManual ? "manual" : "auto"}
          onChange={event => setReasoningManual(event.target.value === "manual")}>
          <option value="auto">{t("ConnectionsView.automatic_protocol")}</option>
          <option value="manual">{t("ConnectionsView.manual")}</option>
        </select>
      </Field>
      {reasoningManual ? <Field label={t("reasoning.native_values")} hint={t("reasoning.native_values_hint")}>
        <textarea className="textarea" aria-label={t("reasoning.native_values")} value={reasoningValues}
          onChange={event => setReasoningValues(event.target.value)} rows={4} />
      </Field> : <p className="small muted">{(model?.connectionId === connectionId && model.modelKey === modelKey.trim() ? model.detectedReasoningEfforts?.join(" / ") : null) || t("reasoning.unknown_hint")}</p>}
      <Field label={t("ConnectionsView.model_protocol")} hint={t("ConnectionsView.effective_model_protocol", { protocol: effectiveProtocol ?? "—" })}>
        <select className="select" aria-label={t("ConnectionsView.model_protocol")} value={protocol ?? ""}
          onChange={(event) => setProtocol((event.target.value || null) as ProviderProtocol | null)}>
          <option value="">{t("ConnectionsView.automatic_protocol")}</option>
          {providerPreset(selectedConnection?.providerId ?? "custom").protocols.map((item) => (
            <option key={item} value={item}>{item === "openai-responses" ? "OpenAI Responses" : item === "openai-chat" ? "OpenAI Chat Completions" : "Anthropic Messages"}</option>
          ))}
        </select>
      </Field>
      <Field label={t("ConnectionsView.image_protocol")} hint={t("ConnectionsView.when_configured_the_model_supports_both_native_responses_image_generation")}>
        <select
          className="select"
          aria-label={t("ConnectionsView.image_protocol")}
          value={imageProtocol ?? ""}
          onChange={(event) => {
            const next = (event.target.value || null) as ModelInput["imageProtocol"];
            setImageProtocol(next);
            setCapabilities((current) => ({ ...current, imageOutput: Boolean(next) }));
          }}
        >
          <option value="">{t("ConnectionsView.disable_image_generation")}</option>
          {(supportedImageProtocols.length
            ? supportedImageProtocols
            : ["openai-images", "google-imagen", "google-interactions", "stability-image"] as const
          ).map((protocol) => (
            <option key={protocol} value={protocol}>
              {protocol === "openai-images"
                ? "OpenAI Images"
                : protocol === "google-imagen"
                ? "Google Imagen"
                : protocol === "google-interactions"
                ? t("ConnectionsView.google_gemini_images")
                : "Stability Image"}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid-3">
        <Field label={t("ConnectionsView.context_window")} hint={t("ConnectionsView.leave_blank_if_unknown")}>
          <input
            className="input"
            type="number"
            aria-label={t("ConnectionsView.context_window")}
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value)}
          />
        </Field>
        <Field label={t("ConnectionsView.maximum_input_tokens")} hint={t("ConnectionsView.uses_the_context_window_when_blank")}>
          <input
            className="input"
            type="number"
            aria-label={t("ConnectionsView.maximum_input_tokens")}
            value={maxInputTokens}
            onChange={(event) => setMaxInputTokens(event.target.value)}
          />
        </Field>
        <Field label={t("ConnectionsView.maximum_output_tokens")}>
          <input
            className="input"
            type="number"
            aria-label={t("ConnectionsView.maximum_output_tokens")}
            value={maxOutputTokens}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </Field>
      </div>
      <Field label={t("ConnectionsView.maximum_input_images")} hint={t("ConnectionsView.leave_blank_for_no_declared_limit_older_images_exceeding_the")}>
        <input
          className="input"
          type="number"
          min="1"
          step="1"
          aria-label={t("ConnectionsView.maximum_input_images")}
          value={maxImageInputs}
          onChange={(event) => setMaxImageInputs(event.target.value)}
        />
      </Field>
      {model?.catalogMetadata ? <ModelCatalogDetails model={model} /> : null}
      <Field label={t("ConnectionsView.capabilities")}>
        <div>
          {getCAPABILITY_LABELS().map(([key, label]) => (
            <label key={key} className="checkbox-row">
              <input
                type="checkbox"
                checked={capabilities[key]}
                onChange={(event) => setCapabilities({ ...capabilities, [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid-2">
        <Field label={t("ConnectionsView.default_temperature")} hint={t("ConnectionsView.leave_blank_to_use_the_provider_default")}>
          <input
            className="input"
            type="number"
            step="0.1"
            aria-label={t("ConnectionsView.default_temperature")}
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
          />
        </Field>
        <Field label={t("ConnectionsView.reasoning_summary")}>
          <select
            className="select"
            aria-label={t("ConnectionsView.reasoning_summary")}
            value={reasoningSummary}
            onChange={(event) => setReasoningSummary(event.target.value)}
          >
            <option value="">{t("ConnectionsView.not_set")}</option>
            <option value="auto">auto</option>
            <option value="concise">concise</option>
            <option value="detailed">detailed</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function ModelCatalogDetails({ model }: { model: ModelDto }) {
  useLocale();
  const metadata = model.catalogMetadata;
  if (!metadata) return null;
  const pricing = metadata.pricing;
  return (
    <details className="model-catalog-details">
      <summary>{t("ConnectionsView.model_catalog_details")}</summary>
      <dl className="catalog-detail-grid">
        <div><dt>{t("ConnectionsView.catalog_identifier")}</dt><dd className="mono">{metadata.providerId} / {metadata.modelId}</dd></div>
        <div><dt>{t("ConnectionsView.family_and_release")}</dt><dd>{metadata.family ?? "—"} · {metadata.releaseDate ?? "—"}</dd></div>
        <div><dt>{t("ConnectionsView.input_modalities")}</dt><dd>{metadata.inputModalities.join("、") || "—"}</dd></div>
        <div><dt>{t("ConnectionsView.output_modalities")}</dt><dd>{metadata.outputModalities.join("、") || "—"}</dd></div>
        <div className="detail-grid-wide"><dt>{t("ConnectionsView.reasoning_levels")}</dt><dd>{metadata.reasoningEfforts.join("、") || t("ConnectionsView.not_specified_in_catalog")}</dd></div>
        {metadata.description ? <div className="detail-grid-wide"><dt>{t("ConnectionsView.notes")}</dt><dd>{metadata.description}</dd></div> : null}
        {pricing ? (
          <div className="detail-grid-wide">
            <dt>{t("ConnectionsView.price_per_million_tokens")}</dt>
            <dd>{t("ConnectionsView.input_output_2", { value1: (pricing.input), value2: (pricing.output), value3: (pricing.cacheRead !== undefined ? t("detail.cache_read", { value1: (pricing.cacheRead) }) : ""), value4: (pricing.cacheWrite !== undefined ? t("detail.cache_write", { value1: (pricing.cacheWrite) }) : "") })}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
