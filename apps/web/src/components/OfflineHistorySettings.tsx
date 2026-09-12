import { displayError } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { clearOfflineHistory, offlineStore, setOfflineEnabled, syncOfflineHistory } from "../lib/offline-history";
import { useStore } from "../lib/store";
import { formatTime } from "../lib/format";

export function OfflineBanner() {
  useLocale();
  const state = useStore(offlineStore, (value) => value);
  if (!state.offline) return null;
  return <div className="offline-banner" role="status">{t("OfflineHistorySettings.offline_reading", { value1: (state.lastSync ? t("detail.last_synced", { value1: (formatTime(state.lastSync)) }) : t("detail.only_records_saved_on_this_device_are_shown")) })}<button className="btn small" disabled={state.syncing} onClick={() => void syncOfflineHistory()}>{t("OfflineHistorySettings.reconnect")}</button>
  </div>;
}
export function OfflineHistorySettings() {
  useLocale();
  const state = useStore(offlineStore, (value) => value);
  const act = (action: Promise<void>) => void action.catch((error: unknown) => offlineStore.set({ error: error instanceof Error ? error.message : t("OfflineHistorySettings.local_storage_unavailable") }));
  return <div className="card" aria-label={t("OfflineHistorySettings.offline_history")}>
    <h3>{t("OfflineHistorySettings.offline_history")}</h3>
    <label className="checkbox-row"><input type="checkbox" checked={state.enabled} onChange={(event) => act(setOfflineEnabled(event.target.checked))} />{t("OfflineHistorySettings.save_conversation_text_and_images_in_this_browser")}</label>
    <p className="hint">{t("OfflineHistorySettings.syncs_all_conversations_while_the_app_is_open_and_online")}</p>
    <p role="status">{t("OfflineHistorySettings.conversations_mb", { value1: (state.syncing ? t("detail.syncing") : t("AgentEditorView.saved")), value2: (state.synced), value3: (state.total), value4: ((state.bytes / 1024 / 1024).toFixed(1)) })}</p>
    <p className="hint">{state.lastSync ? t("OfflineHistorySettings.last_full_sync", { value1: (formatTime(state.lastSync)) }) : t("OfflineHistorySettings.first_sync_not_completed")}{state.imagesMissing ? t("OfflineHistorySettings.images_not_downloaded", { value1: (state.imagesMissing) }) : ""}</p>
    {state.error ? <p role="alert">{displayError({ message: state.error, ...(state.errorI18n ? { i18n: state.errorI18n } : {}) })}</p> : null}
    <div className="row">
      <button className="btn" disabled={!state.enabled || state.syncing} onClick={() => act(syncOfflineHistory())}>{t("OfflineHistorySettings.sync_now")}</button>
      <button className="btn" onClick={() => act(clearOfflineHistory({ disable: true }))}>{t("OfflineHistorySettings.clear_local_history_and_disable")}</button>
    </div>
  </div>;
}
