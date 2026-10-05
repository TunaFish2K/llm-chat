import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { IconButton } from "./ui";
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
  return <div className="server-channel-list" role="radiogroup">
    {options.map((origin) => {
      const active = state.active === origin;
      // The delete button stays outside the label so it neither selects nor names the radio.
      return <div className="server-channel-card" key={origin ?? "page"} data-selected={active || undefined}>
        <label className="server-channel-choice">
          <input className="server-channel-radio" type="radio" name="server-channel" checked={active} onChange={() => selectChannel(origin)} />
          <span className="server-channel-address">{origin ?? location.origin}</span>
          <span className="server-channel-tags">
            {origin ? null : <span className="tag">{t("ServerChannelSettings.current_address")}</span>}
            {active ? <span className="tag accent">{t("ServerChannelSettings.active")}</span> : null}
          </span>
        </label>
        {origin ? <IconButton label={t("ServerChannelSettings.remove_channel", { value1: origin })} danger
          onClick={() => removeChannel(origin)}><Trash2 size={15} /></IconButton> : null}
      </div>;
    })}
  </div>;
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
    <div className="row server-channel-identity">
      <p className="hint">{state.boundServerId
        ? t("ServerChannelSettings.bound_server", { value1: state.boundServerId })
        : t("ServerChannelSettings.unbound_server")}</p>
      {state.boundServerId ? <button type="button" className="btn small" onClick={() => setConfirmReset(true)}>{t("ServerChannelSettings.reset_binding")}</button> : null}
    </div>
    {confirmReset ? <ConfirmModal danger title={t("ServerChannelSettings.reset_binding")} message={t("ServerChannelSettings.reset_binding_message")}
      confirmLabel={t("ServerChannelSettings.reset_binding")} onClose={() => setConfirmReset(false)} onConfirm={() => void reset()} /> : null}
  </div>;
}
