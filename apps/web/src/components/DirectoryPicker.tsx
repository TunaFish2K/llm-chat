import { displayError } from "../lib/error-display";
import { t, useLocale } from "../lib/i18n";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DirectoryListingDto } from "@llm-chat/contracts";
import { ApiRequestError, endpoints } from "../lib/api";
import { ErrorState, LoadingState, Modal } from "../lib/ui";

interface DirectoryError {
  message: unknown;
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
  useLocale();
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
      setError({ message: t("DirectoryPicker.enter_a_directory_path"), invalidPath: true });
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
        message: cause instanceof Error ? cause : t("DirectoryPicker.could_not_read_the_directory_try_again"),
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
        message: cause instanceof Error ? cause : t("DirectoryPicker.could_not_validate_the_working_directory_try_again"),
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
      setError({ message: cause instanceof Error ? cause : t("DirectoryPicker.could_not_create_the_directory_try_again"), invalidPath: false });
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  return (
    <Modal
      title={t("SettingsView.choose_working_directory")}
      onClose={close}
      footer={
        <>
          {initialPath !== null ? (
            <button className="btn" disabled={busy} onClick={() => { ++requestId.current; onSelect(null); }}>{t("DirectoryPicker.clear_directory")}</button>
          ) : null}
          <button className="btn" onClick={close}>{t("WorkspaceSidebar.cancel")}</button>
          <button className="btn primary" disabled={!canUseDirectory} onClick={() => void select()}>
            {busy ? t("DirectoryPicker.processing") : t("DirectoryPicker.use_this_directory")}
          </button>
        </>
      }
    >
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) void load(pathInput); }}>
        <label htmlFor={pathId}>{t("DirectoryPicker.directory_path")}</label>
        <div className="directory-path-row">
          <input
            id={pathId}
            className="input mono"
            value={pathInput}
            disabled={busy}
            placeholder={t("DirectoryPicker.enter_an_absolute_directory_path_on_the_server")}
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
          <button className="btn" type="submit" disabled={busy}>{t("InspectorPanel.open")}</button>
        </div>
        <p id={hintId} className="small muted">{t("DirectoryPicker.enter_an_absolute_server_path_open_it_then_confirm_your", { value1: (!currentPathOpened && listing ? t("detail.open_the_entered_path_first") : "") })}</p>
      </form>
      {error ? <div id={errorId}><ErrorState message={displayError(error.message)} {...(error.retry ? { onRetry: error.retry } : {})} /></div> : null}
      {loading ? <LoadingState label={t("DirectoryPicker.reading_directory")} /> : null}
      {!listing && error ? (
        <button className="btn" disabled={busy} onClick={() => void load()}>{t("DirectoryPicker.open_root_directory")}</button>
      ) : null}
      {listing ? (
        <>
          <p className="small mono muted" style={{ wordBreak: "break-all" }}>{t("DirectoryPicker.current_directory", { value1: (listing.path) })}</p>
          <div className="dir-list" role="listbox" aria-label={t("DirectoryPicker.directory_list")}>
            {listing.parentPath !== null ? (
              <button className="dir-row" disabled={busy} onClick={() => void load(listing.parentPath ?? undefined)}>{t("DirectoryPicker.parent_directory")}</button>
            ) : null}
            {listing.entries
              .filter((entry) => entry.directory)
              .map((entry) => (
                <button key={entry.path} className="dir-row" disabled={busy} onClick={() => void load(entry.path)}>
                  📁 {entry.name}
                </button>
              ))}
            {listing.entries.filter((entry) => entry.directory).length === 0 ? (
              <p className="muted small" style={{ padding: "8px 12px" }}>{t("DirectoryPicker.this_directory_has_no_subdirectories")}</p>
            ) : null}
          </div>
          <div className="directory-path-row">
            <input
              className="input"
              placeholder={t("DirectoryPicker.new_directory_name")}
              aria-label={t("DirectoryPicker.new_directory_name")}
              value={newDirName}
              disabled={busy || loading || !currentPathOpened}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => { setNewDirName(event.target.value); setError(null); }}
            />
            <button className="btn" disabled={!canUseDirectory || !newDirName.trim()} onClick={() => void mkdir()}>{t("DirectoryPicker.create_directory")}</button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
