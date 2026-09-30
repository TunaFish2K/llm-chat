import { DelayedLoading } from "../DelayedLoading";
import { Modal } from "../AnimatedModal";
export { Modal };
import { t, useLocale } from "../../lib/i18n";
/**
 * The console's primitive layer.
 *
 * Everything visual in the app is composed from these pieces, so the shell,
 * the chat surface and the management screens stay visually consistent without
 * each of them re-deriving markup or class names.
 */
import {
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { Search, X } from "lucide-react";

/* Buttons ---------------------------------------------------------------- */

type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function Button({
  variant = "neutral",
  size = "md",
  block,
  iconOnly,
  children,
  ...rest
}: ButtonBase & {
  variant?: "neutral" | "primary" | "danger" | "ghost";
  size?: "md" | "sm";
  block?: boolean;
  iconOnly?: boolean;
  children?: ReactNode;
}) {
  useLocale();
  const className = [
    "btn",
    variant === "neutral" ? "" : variant,
    size === "sm" ? "small" : "",
    iconOnly ? "icon" : "",
    block ? "block" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" {...rest} className={className}>
      {children}
    </button>
  );
}

/** A borderless square control; the label is mandatory so it stays reachable. */
export function IconButton({
  label,
  danger,
  children,
  ...rest
}: ButtonBase & { label: string; danger?: boolean; children: ReactNode }) {
  useLocale();
  return (
    <button
      type="button"
      {...rest}
      className={danger ? "icon-button danger" : "icon-button"}
      aria-label={label}
      title={rest.title ?? label}
    >
      {children}
    </button>
  );
}

/* Feedback --------------------------------------------------------------- */

export function Spinner({ label = t("index.loading") }: { label?: string }) {
  useLocale();
  return (
    <span role="status" aria-label={label}>
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  useLocale();
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="small">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  useLocale();
  return (
    <div className="error-box" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>{t("NotificationSettings.retry")}</button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = t("index.loading_2") }: { label?: string }) {
  useLocale();
  return (
    <DelayedLoading><div className="loading-box" role="status">
      <span className="spinner" aria-hidden="true" /> <span>{label}</span>
    </div></DelayedLoading>
  );
}

/* Form scaffolding -------------------------------------------------------- */

export function Field({
  label,
  hint,
  children,
  htmlFor,
  wide
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
  htmlFor?: string | undefined;
  wide?: boolean;
}) {
  useLocale();
  return (
    <div className={wide ? "field span-2" : "field"}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  useLocale();
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({
  label,
  value,
  onChange,
  placeholder,
  compact,
  autoFocus
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  useLocale();
  return (
    <label className={compact ? "search-field compact" : "search-field"}>
      <Search size={14} aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="icon-button" aria-label={t("index.clear_search")} onClick={() => onChange("")}>
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

/* Structure --------------------------------------------------------------- */

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  useLocale();
  return (
    <section className="card">
      {title || actions ? (
        <header>
          {typeof title === "string" ? <h3>{title}</h3> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The management-screen row. Content and actions are separate slots so the
 * stylesheet can stack them under narrow viewports without the action labels
 * ever being clipped.
 */
export function ListRow({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  useLocale();
  return (
    <div className="list-row">
      <div className="list-row-content">{children}</div>
      {actions ? <div className="list-row-actions">{actions}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  useLocale();
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* Modal ------------------------------------------------------------------- */

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
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t("WorkspaceSidebar.cancel")}</button>
          <button
            type="button"
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

/* Status vocabulary ------------------------------------------------------- */

export function StatusDot({ kind, label }: { kind: "ok" | "warn" | "err" | "run" | "idle"; label: string }) {
  useLocale();
  return (
    <span className="connection-dot">
      <span className={kind === "idle" ? "dot" : `dot ${kind}`} aria-hidden="true" />
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

export function statusKind(status: string): "ok" | "warn" | "err" | "accent" {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "timed_out" || status === "interrupted") return "err";
  if (status === "stopped" || status === "waiting-approval") return "warn";
  return "accent";
}

export function StatusTag({ status }: { status: string }) {
  useLocale();
  return <span className={`tag ${statusKind(status)}`}>{statusLabel(status)}</span>;
}

export function Tag({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "err" | "accent"; children: ReactNode }) {
  useLocale();
  return <span className={tone === "neutral" ? "tag" : `tag ${tone}`}>{children}</span>;
}
