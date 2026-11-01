import { useState, useSyncExternalStore } from "react";
import { useErrorState } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { getPwaState, promptInstall, subscribePwa } from "../lib/pwa";

export function PwaInstallSettings() {
  useLocale();
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useErrorState();
  // iPadOS identifies as a Mac when requesting desktop websites.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const install = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await promptInstall(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };

  return <div className="card" aria-label={t("PwaInstallSettings.title")}>
    <h3>{t("PwaInstallSettings.title")}</h3>
    <p className="hint">{t("PwaInstallSettings.description")}</p>
    {pwa.installed ? <p role="status">{t("PwaInstallSettings.installed")}</p>
      : busy ? <p role="status">{t("PwaInstallSettings.installing")}</p>
      : pwa.installAvailable ? <button type="button" className="btn" onClick={() => void install()}>{t("PwaInstallSettings.title")}</button>
      : <p className="hint">{t(ios ? "PwaInstallSettings.ios_instructions" : "PwaInstallSettings.browser_instructions")}</p>}
    {error && !pwa.installed ? <p role="alert">{error}</p> : null}
  </div>;
}
