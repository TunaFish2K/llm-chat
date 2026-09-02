import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async (path?: string) => {
    setError(null);
    setListing(null);
    try {
      setListing(await endpoints.listDirectories(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取目录");
    }
  }, []);

  useEffect(() => {
    void load(initialPath ?? undefined);
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
            <button className="btn" onClick={() => onSelect(null)}>
              清除目录
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
            使用当前目录
          </button>
        </>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={() => void load(initialPath ?? undefined)} />
      ) : !listing ? (
        <LoadingState label="读取目录…" />
      ) : (
        <>
          <p className="small mono muted" style={{ wordBreak: "break-all" }}>
            {listing.path}
          </p>
          <div className="dir-list" role="listbox" aria-label="目录列表">
            {listing.parentPath !== null ? (
              <button className="dir-row" onClick={() => void load(listing.parentPath ?? undefined)}>
                ⬅ 上级目录
              </button>
            ) : null}
            {listing.entries
              .filter((entry) => entry.directory)
              .map((entry) => (
                <button key={entry.path} className="dir-row" onClick={() => void load(entry.path)}>
                  📁 {entry.name}
                </button>
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
            <button className="btn" disabled={busy || !newDirName.trim()} onClick={() => void mkdir()}>
              新建目录
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
