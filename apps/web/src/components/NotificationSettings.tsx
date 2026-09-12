import { displayError } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { useEffect } from "react";
import { initializeNotifications, notificationStore, setNotificationsEnabled } from "../lib/notifications";
import { useStore } from "../lib/store";
import { Switch } from "../lib/ui";

export function NotificationSettings() {
  useLocale();
  const state = useStore(notificationStore, (value) => value);
  useEffect(() => { void initializeNotifications(); }, []);
  return <div className="card" aria-label={t("NotificationSettings.conversation_notifications")}>
    <h3>{t("NotificationSettings.conversation_notifications")}</h3>
    <Switch label={t("NotificationSettings.enable_conversation_notifications")} checked={state.enabled}
      disabled={!state.initialized || !state.supported || state.busy}
      onChange={(enabled) => void setNotificationsEnabled(enabled)} />
    <p className="hint">{t("NotificationSettings.get_system_notifications_for_completed_replies_generation_errors_and_pending")}</p>
    <p className="hint">{t("NotificationSettings.keep_the_page_open_notifications_may_not_arrive_after_you")}</p>
    <p role="status">{!state.initialized ? t("NotificationSettings.checking_notification_support") : !state.supported
      ? window.isSecureContext ? t("NotificationSettings.this_browser_does_not_support_conversation_notifications_on_iphone_or") : t("NotificationSettings.conversation_notifications_require_https_or_a_local_address")
      : state.busy ? t("NotificationSettings.updating_notification_settings")
      : state.permission === "denied" ? t("NotificationSettings.notifications_were_denied_allow_them_in_your_browser_s_site")
      : (state.hint ? displayError({ message: state.hint, ...(state.hintI18n ? { i18n: state.hintI18n } : {}) }) : null) ?? (state.enabled ? t("NotificationSettings.conversation_notifications_enabled") : t("NotificationSettings.conversation_notifications_disabled"))}</p>
    {state.error ? <><p role="alert">{displayError({ message: state.error, ...(state.errorI18n ? { i18n: state.errorI18n } : {}) })}</p><button className="btn" disabled={state.busy}
      onClick={() => void setNotificationsEnabled(true)}>{t("NotificationSettings.retry")}</button></> : null}
  </div>;
}
