import { clearOfflineHistory, offlineStore, setOfflineEnabled, syncOfflineHistory } from "../lib/offline-history";
import { useStore } from "../lib/store";
import { formatTime } from "../lib/format";

export function OfflineBanner() {
  const state = useStore(offlineStore, (value) => value);
  if (!state.offline) return null;
  return <div className="offline-banner" role="status">离线查阅 · {state.lastSync ? `最后同步 ${formatTime(state.lastSync)}` : "仅显示本机已保存的记录"}
    <button className="btn small" disabled={state.syncing} onClick={() => void syncOfflineHistory()}>重新连接</button>
  </div>;
}
export function OfflineHistorySettings() {
  const state = useStore(offlineStore, (value) => value);
  const act = (action: Promise<void>) => void action.catch((error: unknown) => offlineStore.set({ error: error instanceof Error ? error.message : "本地存储不可用" }));
  return <div className="card" aria-label="离线记录">
    <h3>离线记录</h3>
    <label className="checkbox-row"><input type="checkbox" checked={state.enabled} onChange={(event) => act(setOfflineEnabled(event.target.checked))} />在此浏览器保存会话文字和图片</label>
    <p className="hint">应用打开且联网时自动同步全部会话。离线可搜索和阅读，普通文件需要联网下载。</p>
    <p role="status">{state.syncing ? "正在同步" : "已保存"} {state.synced} / {state.total} 个会话 · {(state.bytes / 1024 / 1024).toFixed(1)} MB</p>
    <p className="hint">{state.lastSync ? `最后完整同步：${formatTime(state.lastSync)}` : "尚未完成首次同步"}{state.imagesMissing ? ` · ${state.imagesMissing} 张图片尚未下载` : ""}</p>
    {state.error ? <p role="alert">{state.error}</p> : null}
    <div className="row">
      <button className="btn" disabled={!state.enabled || state.syncing} onClick={() => act(syncOfflineHistory())}>立即同步</button>
      <button className="btn" onClick={() => act(clearOfflineHistory({ disable: true }))}>清除本机记录并关闭</button>
    </div>
  </div>;
}
