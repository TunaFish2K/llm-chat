import { useState, type FormEvent } from "react";
import { t, useLocale } from "../lib/i18n";
import { clearOfflineHistory } from "../lib/offline-history";
import { clearStartupCache } from "../lib/startup-cache";
import { addChannel, removeChannel, resetServerBinding, selectChannel, useServerChannels, type ChannelInputError } from "../lib/server-channel";
import { ConfirmModal } from "../lib/ui";

const INPUT_ERRORS: Record<ChannelInputError, () => string> = {
  invalid: () => t("ServerChannelSettings.error_invalid"),
  scheme: () => t("ServerChannelSettings.error_scheme", { value1: location.protocol.replace(":", "") }),
  site: () => t("ServerChannelSettings.error_site"),
  current: () => t("ServerChannelSettings.error_current"),
  duplicate: () => t("ServerChannelSettings.error_duplicate")
};

/** Choice between the page origin and the channels saved on this device. */
export function ServerChannelChoices() {
  useLocale();
  const state = useServerChannels();
  const options: Array<string | null> = [null, ...state.channels];
  return <fieldset className="choice-fieldset">
    <legend>{t("ServerChannelSettings.active_channel")}</legend>
    {options.map((origin) => <div className="row server-channel-row" key={origin ?? "page"}>
      <label className="checkbox-row">
        <input type="radio" name="server-channel" checked={state.active === origin} onChange={() => selectChannel(origin)} />
        {origin ?? t("ServerChannelSettings.current_address", { value1: location.origin })}
      </label>
      {origin ? <button type="button" className="btn small ghost" aria-label={t("ServerChannelSettings.remove_channel", { value1: origin })}
        onClick={() => removeChannel(origin)}>{t("ServerChannelSettings.remove")}</button> : null}
    </div>)}
  </fieldset>;
}

export function ServerChannelSettings() {
  useLocale();
  const state = useServerChannels();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<ChannelInputError | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const failure = addChannel(address);
    setError(failure);
    if (!failure) setAddress("");
  };
  const reset = async () => {
    clearStartupCache();
    await clearOfflineHistory().catch(() => {});
    resetServerBinding();
    location.reload();
  };
  return <div className="card" aria-label={t("ServerChannelSettings.title")}>
    <h3>{t("ServerChannelSettings.title")}</h3>
    <p className="hint">{t("ServerChannelSettings.description")}</p>
    <ServerChannelChoices />
    {state.mismatch ? <p role="alert">{t("http_client.server_channel_mismatch")}</p> : null}
    <form className="row" onSubmit={add}>
      <input className="input" value={address} aria-label={t("ServerChannelSettings.address")} placeholder="https://example.com:8443"
        autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url"
        onChange={(event) => { setAddress(event.target.value); setError(null); }} />
      <button className="btn" type="submit" disabled={!address.trim()}>{t("ServerChannelSettings.add")}</button>
    </form>
    {error ? <p role="alert">{INPUT_ERRORS[error]()}</p> : null}
    {!state.saved ? <p role="alert">{t("ServerChannelSettings.not_saved")}</p> : null}
    <p className="hint">{state.boundServerId
      ? t("ServerChannelSettings.bound_server", { value1: state.boundServerId.slice(0, 8) })
      : t("ServerChannelSettings.unbound_server")}</p>
    {state.boundServerId ? <button type="button" className="btn small" onClick={() => setConfirmReset(true)}>{t("ServerChannelSettings.reset_binding")}</button> : null}
    {confirmReset ? <ConfirmModal danger title={t("ServerChannelSettings.reset_binding")} message={t("ServerChannelSettings.reset_binding_message")}
      confirmLabel={t("ServerChannelSettings.reset_binding")} onClose={() => setConfirmReset(false)} onConfirm={() => void reset()} /> : null}
  </div>;
}
