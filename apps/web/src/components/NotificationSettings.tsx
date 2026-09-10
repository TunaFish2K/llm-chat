import { useEffect } from "react";
import { initializeNotifications, notificationStore, setNotificationsEnabled } from "../lib/notifications";
import { useStore } from "../lib/store";
import { Switch } from "../lib/ui";

export function NotificationSettings() {
  const state = useStore(notificationStore, (value) => value);
  useEffect(() => { void initializeNotifications(); }, []);
  return <div className="card" aria-label="会话通知">
    <h3>会话通知</h3>
    <Switch label="开启会话通知" checked={state.enabled}
      disabled={!state.initialized || !state.supported || state.busy}
      onChange={(enabled) => void setNotificationsEnabled(enabled)} />
    <p className="hint">目标会话不在前台时，回复完成、生成异常或工具待审批会发送系统通知。设置仅保存在此浏览器。</p>
    <p className="hint">页面需要保持打开；关闭页面或被系统挂起后，可能无法收到通知。</p>
    <p role="status">{!state.initialized ? "正在检查通知支持…" : !state.supported
      ? window.isSecureContext ? "当前浏览器不支持会话通知。iPhone 或 iPad 可尝试添加到主屏幕后打开。" : "会话通知需要 HTTPS 或本机地址。"
      : state.busy ? "正在设置通知…"
      : state.permission === "denied" ? "通知已被拒绝，请在浏览器的站点设置中允许通知后重新开启。"
      : state.hint ?? (state.enabled ? "会话通知已开启" : "会话通知已关闭")}</p>
    {state.error ? <><p role="alert">{state.error}</p><button className="btn" disabled={state.busy}
      onClick={() => void setNotificationsEnabled(true)}>重试</button></> : null}
  </div>;
}
