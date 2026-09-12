import { useErrorState } from "../lib/error-display";
import { LanguagePicker } from "../components/LanguagePicker";
import { t, useLocale } from "../lib/i18n";
import { useState, type FormEvent } from "react";
import { endpoints } from "../lib/api";
import { bootstrap } from "../lib/app-state";

export function LoginView() {
  useLocale();
  const [password, setPassword] = useState("");
  const [error, setError] = useErrorState(null);
  const [busy, setBusy] = useState(false);

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
        <div className="field">
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
        </div>
        {error ? (
          <p role="alert" className="small" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <button className="btn primary" type="submit" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? t("LoginView.signing_in") : t("LoginView.sign_in")}
        </button>
        <p className="small muted" style={{ marginTop: 16, textAlign: "center" }}>{t("LoginView.the_initial_password_is_printed_in_the_server_log_on")}</p>
      </form>
    </div>
  );
}
