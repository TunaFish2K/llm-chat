import { Modal } from "../components/AnimatedModal";
export { Modal };
import { t, useLocale } from "./i18n";
import type { ReactNode } from "react";

export function Spinner({ label = t("index.loading") }: { label?: string }) {
  useLocale();
  return (
    <span role="status" aria-label={label} className="icon-btn-label">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  useLocale();
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="small">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  useLocale();
  return (
    <div className="error-box" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button className="btn" onClick={onRetry}>{t("NotificationSettings.retry")}</button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = t("index.loading_2") }: { label?: string }) {
  useLocale();
  return (
    <div className="loading-box" role="status">
      <span className="spinner" aria-hidden="true" /> <span>{label}</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
  htmlFor?: string | undefined;
}) {
  useLocale();
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Switch({
  label,
  checked,
  disabled = false,
  hideLabel = false,
  onChange
}: {
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  onChange: (checked: boolean) => void;
}) {
  useLocale();
  return (
    <label className={`switch-control${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true"><span /></span>
      <span className={hideLabel ? "sr-only" : "switch-label"}>{label}</span>
    </label>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = t("index.confirm"),
  danger,
  onConfirm,
  onClose,
  busy,
  confirmDisabled
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
}) {
  useLocale();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>{t("WorkspaceSidebar.cancel")}</button>
          <button
            className={danger ? "btn danger" : "btn primary"}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? t("DirectoryPicker.processing") : confirmLabel}
          </button>
        </>
      }
    >
      {typeof message === "string" ? <p>{message}</p> : message}
    </Modal>
  );
}

export function StatusDot({ kind, label }: { kind: "ok" | "warn" | "err" | "run" | "idle"; label: string }) {
  useLocale();
  return (
    <span className="connection-dot">
      <span className={`dot ${kind === "idle" ? "" : kind}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function getSTATUS_LABELS(): Record<string, string> { return {
  queued: t("index.queued"),
  running: t("index.running"),
  "waiting-approval": t("index.waiting_for_approval"),
  completed: t("index.completed"),
  stopped: t("index.stopped"),
  failed: t("index.failed"),
  interrupted: t("index.interrupted"),
  starting: t("index.starting"),
  timed_out: t("index.timed_out")
}; }

export function statusLabel(status: string): string {
  return getSTATUS_LABELS()[status] ?? status;
}

export function StatusTag({ status }: { status: string }) {
  useLocale();
  const kind =
    status === "completed"
      ? "ok"
      : status === "failed" || status === "timed_out" || status === "interrupted"
        ? "err"
        : status === "stopped" || status === "waiting-approval"
          ? "warn"
          : "accent";
  return <span className={`tag ${kind}`}>{statusLabel(status)}</span>;
}
