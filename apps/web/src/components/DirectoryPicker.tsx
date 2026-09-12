import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DirectoryListingDto } from "@llm-chat/contracts";
import { ApiRequestError, endpoints } from "../lib/api";
import { ErrorState, LoadingState, Modal } from "../lib/ui";

interface DirectoryError {
  message: string;
  invalidPath: boolean;
  retry?: () => void;
}

function isPathError(cause: unknown): boolean {
  return cause instanceof ApiRequestError && ["workspace_invalid", "validation_error"].includes(cause.code);
}

export function DirectoryPicker({
  initialPath,
  onSelect,
  onClose
}: {
  initialPath: string | null;
  onSelect: (path: string | null) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirectoryListingDto | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [error, setError] = useState<DirectoryError | null>(null);
  const [newDirName, setNewDirName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const pathId = useId();
  const errorId = useId();
  const hintId = useId();

  const load = useCallback(async (path?: string) => {
    const id = ++requestId.current;
    setPathInput(path ?? "");
    setError(null);
    setLoading(false);
    if (path !== undefined && !path.trim()) {
      setError({ message: "请输入目录路径", invalidPath: true });
      return;
    }
    setLoading(true);
    try {
      const result = await endpoints.listDirectories(path);
      if (id !== requestId.current) return;
      setListing(result);
      setPathInput(result.path);
      setNewDirName("");
    } catch (cause) {
      if (id !== requestId.current) return;
      setError({
        message: cause instanceof Error ? cause.message : "无法读取目录，请重试",
        invalidPath: isPathError(cause),
        retry: () => void load(path)
      });
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath ?? undefined);
    return () => { ++requestId.current; };
  }, [initialPath, load]);

  const close = () => {
    ++requestId.current;
    onClose();
  };
  const currentPathOpened = listing !== null && pathInput === listing.path;
  const canUseDirectory = currentPathOpened && !loading && !busy && !error;

  const select = async () => {
    if (!listing || !currentPathOpened || loading || busy) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.validatePath(listing.path);
      if (id === requestId.current) onSelect(result.path);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError({
        message: cause instanceof Error ? cause.message : "无法校验工作目录，请重试",
        invalidPath: isPathError(cause),
        retry: () => void select()
      });
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  const mkdir = async () => {
    if (!listing || !canUseDirectory || !newDirName.trim()) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const base = listing.path.replace(/\/+$/, "");
      const result = await endpoints.createDirectory(`${base}/${newDirName.trim()}`);
      if (id !== requestId.current) return;
      setNewDirName("");
      setBusy(false);
      await load(result.path);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError({ message: cause instanceof Error ? cause.message : "无法新建目录，请重试", invalidPath: false });
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  return (
    <Modal
      title="选择工作目录"
      onClose={close}
      footer={
        <>
          {initialPath !== null ? (
            <button className="btn" disabled={busy} onClick={() => { ++requestId.current; onSelect(null); }}>
              清除目录
            </button>
          ) : null}
          <button className="btn" onClick={close}>
            取消
          </button>
          <button className="btn primary" disabled={!canUseDirectory} onClick={() => void select()}>
            {busy ? "处理中…" : "使用当前目录"}
          </button>
        </>
      }
    >
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) void load(pathInput); }}>
        <label htmlFor={pathId}>目录路径</label>
        <div className="directory-path-row">
          <input
            id={pathId}
            className="input mono"
            value={pathInput}
            disabled={busy}
            placeholder="输入服务端绝对目录路径"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error?.invalidPath || undefined}
            aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
            onChange={(event) => {
              ++requestId.current;
              setLoading(false);
              setError(null);
              setPathInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
          />
          <button className="btn" type="submit" disabled={busy}>打开</button>
        </div>
        <p id={hintId} className="small muted">
          输入服务端绝对路径，打开后再确认选择。{!currentPathOpened && listing ? "请先打开输入的路径。" : ""}
        </p>
      </form>
      {error ? <div id={errorId}><ErrorState message={error.message} {...(error.retry ? { onRetry: error.retry } : {})} /></div> : null}
      {loading ? <LoadingState label="读取目录…" /> : null}
      {!listing && error ? (
        <button className="btn" disabled={busy} onClick={() => void load()}>打开根目录</button>
      ) : null}
      {listing ? (
        <>
          <p className="small mono muted" style={{ wordBreak: "break-all" }}>
            当前目录：{listing.path}
          </p>
          <div className="dir-list" role="listbox" aria-label="目录列表">
            {listing.parentPath !== null ? (
              <button className="dir-row" disabled={busy} onClick={() => void load(listing.parentPath ?? undefined)}>
                ⬅ 上级目录
              </button>
            ) : null}
            {listing.entries
              .filter((entry) => entry.directory)
              .map((entry) => (
                <button key={entry.path} className="dir-row" disabled={busy} onClick={() => void load(entry.path)}>
                  📁 {entry.name}
                </button>
              ))}
            {listing.entries.filter((entry) => entry.directory).length === 0 ? (
              <p className="muted small" style={{ padding: "8px 12px" }}>
                此目录没有子目录。
              </p>
            ) : null}
          </div>
          <div className="directory-path-row">
            <input
              className="input"
              placeholder="新目录名称"
              aria-label="新目录名称"
              value={newDirName}
              disabled={busy || loading || !currentPathOpened}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => { setNewDirName(event.target.value); setError(null); }}
            />
            <button className="btn" disabled={!canUseDirectory || !newDirName.trim()} onClick={() => void mkdir()}>
              新建目录
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
