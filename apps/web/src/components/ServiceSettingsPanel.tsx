import { useErrorState } from "../lib/error-display";
import { t, useLocale, localized } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ServiceSettingsDto, ServiceSettingsInput } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { toast, toastError } from "../lib/app-state";
import { ErrorState, Field, LoadingState, Switch } from "../lib/ui";

export function ServiceSettingsPanel({ kind }: { kind: "search" | "image" }) {
  useLocale();
  const [data, setData] = useState<ServiceSettingsDto | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useErrorState(null);
  const load = useCallback(() => endpoints.serviceSettings().then(setData).catch((cause) => setError(String(cause))), []);
  useEffect(() => { void load(); }, [load]);
  const save = async (input: ServiceSettingsInput) => {
    setBusy(true);
    try { setData(await endpoints.updateServiceSettings(input)); setKeys({}); toast("success", localized("ServiceSettingsPanel.saved_preference_order_and_configuration")); }
    catch (cause) { toastError(cause); }
    finally { setBusy(false); }
  };
  if (error) return <ErrorState message={error} onRetry={() => { setError(null); void load(); }} />;
  if (!data) return <LoadingState />;
  const input = (next = data): ServiceSettingsInput => kind === "search"
    ? { searchEngines: next.searchEngines.map((engine) => ({ ...engine, ...(keys[engine.id] !== undefined ? { apiKey: keys[engine.id] } : {}) })) }
    : { imageModels: next.imageModels.map(({ modelId, enabled }) => ({ modelId, enabled })) };
  const move = (index: number, direction: number) => {
    const next = { ...data };
    if (kind === "search") { next.searchEngines = [...data.searchEngines]; [next.searchEngines[index], next.searchEngines[index + direction]] = [next.searchEngines[index + direction]!, next.searchEngines[index]!]; }
    else { next.imageModels = [...data.imageModels]; [next.imageModels[index], next.imageModels[index + direction]] = [next.imageModels[index + direction]!, next.imageModels[index]!]; }
    setData(next);
    void save(input(next));
  };
  const items = kind === "search" ? data.searchEngines : data.imageModels;
  return <div className="card service-settings">
    <h3>{kind === "search" ? t("SettingsView.search_engines") : t("ServiceSettingsPanel.image_tool_models")}</h3>
    <p className="hint">{t("ServiceSettingsPanel.enable_multiple_options_if_needed_earlier_options_are_recommended_to")}</p>
    {kind === "image" ? <p className="hint">{t("ServiceSettingsPanel.models_come_from_connections_and_models_image_tools_require_an")}</p> : null}
    {!items.length ? <p className="hint">{t("ServiceSettingsPanel.add_a_model_with_image_output_support_in_connections_and")}</p> : null}
    <fieldset disabled={busy} className="service-fields"><ol className="service-list">{items.map((item, index) => <li key={item.id}>
      <div className="service-heading">
        <Switch label={"provider" in item ? `${item.provider === "tavily" ? "Tavily" : "SearXNG"} · ${item.id}` : `${item.name} · ${item.connectionName}`}
          checked={item.enabled} onChange={(enabled) => {
            const next = kind === "search" ? { ...data, searchEngines: data.searchEngines.map((entry) => entry.id === item.id ? { ...entry, enabled } : entry) }
              : { ...data, imageModels: data.imageModels.map((entry) => entry.id === item.id ? { ...entry, enabled } : entry) };
            setData(next);
          }} />
        <div className="service-order">
          <button className="icon-button" title={t("AgentEditorView.move_up")} aria-label={t("ServiceSettingsPanel.move_up", { value1: (item.id) })} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={17} /></button>
          <button className="icon-button" title={t("AgentEditorView.move_down")} aria-label={t("ServiceSettingsPanel.move_down", { value1: (item.id) })} disabled={busy || index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={17} /></button>
        </div>
      </div>
      {"provider" in item ? <div className="grid-2">
        <Field label={t("ServiceSettingsPanel.service_url")} hint={item.provider === "tavily" ? t("ServiceSettingsPanel.leave_blank_to_use_the_default_tavily_url") : t("ServiceSettingsPanel.enter_the_searxng_url_and_enable_its_json_search_api")}>
          <input className="input" value={item.baseUrl} onChange={(event) => setData({ ...data, searchEngines: data.searchEngines.map((entry) => entry.id === item.id ? { ...entry, baseUrl: event.target.value } : entry) })} />
        </Field>
        <Field label="API Key" hint={item.hasApiKey ? t("ServiceSettingsPanel.configured_leave_blank_to_keep_it_or_select_clear_to") : item.provider === "tavily" ? t("ServiceSettingsPanel.tavily_requires_an_api_key") : t("ConnectionsView.optional")}>
          <div className="row"><input className="input" type="password" autoComplete="new-password" value={keys[item.id] ?? ""} onChange={(event) => {
            const next = { ...keys }; if (event.target.value) next[item.id] = event.target.value; else delete next[item.id]; setKeys(next);
          }} /><button className="btn small" onClick={() => setKeys({ ...keys, [item.id]: "" })}>{t("ServiceSettingsPanel.clear")}</button></div>
          {keys[item.id] === "" ? <small>{t("ServiceSettingsPanel.remove_key_on_save")}</small> : null}
        </Field>
      </div> : <><code className="service-model-id">{item.id}</code>{!item.available && item.enabled ? <p className="hint">{t("ServiceSettingsPanel.make_sure_the_model_is_enabled_and_has_an_image")}</p> : null}</>}
    </li>)}</ol></fieldset>
    <button className="btn primary" disabled={busy} onClick={() => void save(input())}>{busy ? t("ServiceSettingsPanel.saving") : t("ServiceSettingsPanel.save_configuration")}</button>
  </div>;
}
