import { ActionButton } from "../lib/action-feedback";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryListingDto } from "@llm-chat/contracts";
import { endpoints } from "../lib/api";
import { toastError } from "../lib/app-state";
import { ErrorState, LoadingState, Modal } from "../lib/ui";

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
  const [error, setError] = useState<string | null>(null);
  const [newDirName, setNewDirName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [targetPath, setTargetPath] = useState(initialPath);
  const readVersion = useRef(0);

  const load = useCallback(async (path?: string) => {
    const version = ++readVersion.current;
    setError(null); setLoading(true); setTargetPath(path ?? initialPath);
    try {
      const next = await endpoints.listDirectories(path);
      if (version === readVersion.current) setListing(next);
    } catch (cause) {
      if (version === readVersion.current) setError(cause instanceof Error ? cause.message : "无法读取目录");
    } finally { if (version === readVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    void load(initialPath ?? undefined);
    return () => { readVersion.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mkdir = async () => {
    if (!listing || !newDirName.trim()) return;
    setBusy(true);
    try {
      const base = listing.path.replace(/\/+$/, "");
      const result = await endpoints.createDirectory(`${base}/${newDirName.trim()}`);
      setNewDirName("");
      await load(result.path);
    } catch (cause) {
      toastError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="选择工作目录"
      onClose={onClose}
      footer={
        <>
          {initialPath !== null ? (
            <ActionButton className="btn" onClick={() => onSelect(null)}>
              清除目录
            </ActionButton>
          ) : null}
          <ActionButton className="btn" onClick={onClose}>
            取消
          </ActionButton>
          <ActionButton className="btn primary" disabled={!listing || loading || Boolean(error)} onClick={() => listing && onSelect(listing.path)}>
            使用当前目录
          </ActionButton>
        </>
      }
    >
      {loading ? <p role="status">正在读取 {targetPath ?? "目录"}…</p> : null}
      {error ? <ErrorState message={error} onRetry={() => load(targetPath ?? undefined)} /> : null}
      {!listing ? (
        <LoadingState label="读取目录…" />
      ) : (
        <>
          <p className="small mono muted" style={{ wordBreak: "break-all" }}>
            {listing.path}
          </p>
          <div className="dir-list" role="listbox" aria-label="目录列表">
            {listing.parentPath !== null ? (
              <ActionButton className="dir-row" disabled={loading} onClick={() => load(listing.parentPath ?? undefined)}>
                ⬅ 上级目录
              </ActionButton>
            ) : null}
            {listing.entries
              .filter((entry) => entry.directory)
              .map((entry) => (
                <ActionButton key={entry.path} className="dir-row" disabled={loading} onClick={() => load(entry.path)}>
                  📁 {entry.name}
                </ActionButton>
              ))}
            {listing.entries.filter((entry) => entry.directory).length === 0 ? (
              <p className="muted small" style={{ padding: "8px 12px" }}>
                此目录没有子目录。
              </p>
            ) : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="新目录名称"
              aria-label="新目录名称"
              value={newDirName}
              onChange={(event) => setNewDirName(event.target.value)}
            />
            <ActionButton className="btn" disabled={busy || !newDirName.trim()} onClick={() => mkdir()}>
              新建目录
            </ActionButton>
          </div>
        </>
      )}
    </Modal>
  );
}
