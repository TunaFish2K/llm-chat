import { setLocalePreference, t, useLocale, type LocalePreference } from "../lib/i18n";

export function LanguagePicker() {
  const { preference, saved } = useLocale();
  return <div className="field">
    <label htmlFor="interface-language">{t("locale.label")}</label>
    <select id="interface-language" className="select" value={preference}
      onChange={(event) => setLocalePreference(event.target.value as LocalePreference)}>
      <option value="system">{t("locale.system")}</option>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
      <option value="en-US" lang="en-US">English (United States)</option>
    </select>
    {!saved && <p className="hint" role="status">{t("locale.storage_failed")}</p>}
  </div>;
}
