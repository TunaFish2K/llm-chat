import type { AuthenticationMethodsDto } from "@llm-chat/contracts";
import { apiUrl } from "../lib/server-channel";
import { useErrorState } from "../lib/error-display";
import { LanguagePicker } from "../components/LanguagePicker";
import { t, useLocale } from "../lib/i18n";
import { useEffect, useState, type FormEvent } from "react";
import { endpoints } from "../lib/api";
import { bootstrap } from "../lib/app-state";
import { ServerChannelChoices } from "../components/ServerChannelSettings";
import { useServerChannels } from "../lib/server-channel";

export function LoginView() {
  useLocale();
  const [password, setPassword] = useState("");
  const [error, setError] = useErrorState(null);
  const [busy, setBusy] = useState(false);
  const channels = useServerChannels().channels;
  const [methods, setMethods] = useState<AuthenticationMethodsDto | null>(null);
  useEffect(() => {
    let active = true;
    setMethods(null);
    void endpoints.authenticationMethods().then((value) => { if (active) setMethods(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause : t("Auth.methods_failed")); });
    return () => { active = false; };
  }, [channels]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.login(password);
      await bootstrap();
    } catch (cause) {
      setError(cause instanceof Error ? cause : t("LoginView.sign_in_failed"));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <img src="/icons/icon-192-v2.png" alt="" width={36} height={36} />
          Chat
        </div>
        <LanguagePicker />
        {methods?.password ? <div className="field">
          <label htmlFor="login-password">{t("LoginView.access_password")}</label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("LoginView.enter_the_shared_access_password")}
          />
        </div> : null}
        {!methods && !error ? <p className="small muted">{t("Auth.loading")}</p> : null}
        {methods?.oidc && methods.oidcLoginPath ? (
          <a className="btn primary" href={apiUrl(methods.oidcLoginPath + "?returnTo=" + encodeURIComponent(location.pathname + location.search + location.hash))}>
            {methods.oidcLabel ?? t("Auth.oidc_sign_in")}
          </a>
        ) : null}
        {error ? (
          <p role="alert" className="small text-danger">
            {error}
          </p>
        ) : null}
        {methods?.password ? <button className="btn primary" type="submit" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? t("LoginView.signing_in") : t("LoginView.sign_in")}
        </button> : null}
        {/* Each channel keeps its own session; switching back must not require signing in here. */}
        {channels.length ? <ServerChannelChoices /> : null}
        {methods?.password ? <p className="small muted" style={{ marginTop: 16, textAlign: "center" }}>{t("LoginView.the_initial_password_is_printed_in_the_server_log_on")}</p> : null}
      </form>
    </div>
  );
}
