import { useState, type FormEvent } from "react";
import { endpoints } from "../lib/api";
import { bootstrap } from "../lib/app-state";

export function LoginView() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      setError(cause instanceof Error ? cause.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <img src="/icons/icon-192.png" alt="" width={36} height={36} />
          Chat
        </div>
        <div className="field">
          <label htmlFor="login-password">访问密码</label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入共享访问密码"
          />
        </div>
        {error ? (
          <p role="alert" className="small" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <button className="btn primary" type="submit" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="small muted" style={{ marginTop: 16, textAlign: "center" }}>
          首次启动的初始密码会打印在服务端日志中。
        </p>
      </form>
    </div>
  );
}
