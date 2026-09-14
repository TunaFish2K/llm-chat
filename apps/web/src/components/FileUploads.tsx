import { useRef } from "react";
import { X, Upload, RotateCcw } from "lucide-react";
import { uploadManager, uploadStore, type UploadTask } from "../lib/file-upload-manager";
import { useStore } from "../lib/store";
import { formatBytes } from "../lib/format";
import { t, useLocale } from "../lib/i18n";

function UploadRow({ scopeId, task }: { scopeId: string; task: UploadTask }) {
  const input = useRef<HTMLInputElement>(null);
  const retryable = ["needs-file", "failed"].includes(task.status);
  const canRetry = Boolean(task.file || (task.created && task.offset === task.byteSize));
  const done = task.status === "hashing" ? task.hashedBytes : task.offset;
  return <div className="file-upload-row">
    <div className="file-upload-name"><span>{task.fileName}</span>
      <button type="button" className="icon-button" aria-label={`${t("uploads.cancel")}: ${task.fileName}`} onClick={() => uploadManager.cancel(scopeId, task.id)}><X size={15} /></button>
    </div>
    <progress max={task.byteSize} value={done} aria-label={t("uploads.progress", { name: task.fileName })} />
    <small>{t(`uploads.${task.status}`)} · {formatBytes(done)} / {formatBytes(task.byteSize)}</small>
    {task.error && <small className="error-text" role="alert">{task.error}</small>}
    {retryable && <>
      <input ref={input} type="file" hidden aria-label={`${t("uploads.select_file")}: ${task.fileName}`} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) uploadManager.retry(scopeId, task.id, file);
      }} />
      <button type="button" className="btn small" onClick={() => canRetry ? uploadManager.retry(scopeId, task.id) : input.current?.click()}>
        <RotateCcw size={14} />{t(canRetry ? "uploads.retry" : "uploads.select_file")}
      </button>
    </>}
  </div>;
}
export function UploadTasks({ scopeId }: { scopeId: string }) {
  useLocale(); useStore(uploadStore, (state) => state.revision);
  const scope = uploadManager.all().find((item) => item.id === scopeId);
  return scope?.tasks.length ? <div className="file-upload-list" aria-label={t("uploads.title")}>
    {scope.tasks.map((task) => <UploadRow key={task.id} scopeId={scopeId} task={task} />)}
  </div> : null;
}
export function GlobalFileUploads() {
  useLocale(); useStore(uploadStore, (state) => state.revision);
  const scopes = uploadManager.all().filter((scope) => scope.tasks.length);
  const count = scopes.reduce((sum, scope) => sum + scope.tasks.length, 0);
  return count ? <details className="global-file-uploads">
    <summary><Upload size={16} />{t("uploads.summary", { count })}</summary>
    <div className="global-file-upload-content">
      <p className="small muted">{t("uploads.resume_hint")}</p>
      {scopes.map((scope) => <UploadTasks key={scope.id} scopeId={scope.id} />)}
    </div>
  </details> : null;
}
