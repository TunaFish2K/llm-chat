/**
 * The console's primitive layer.
 *
 * Everything visual in the app is composed from these pieces, so the shell,
 * the chat surface and the management screens stay visually consistent without
 * each of them re-deriving markup or class names.
 */
import {
  useEffect,
  useId,
  useRef,
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

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <span role="status" aria-label={label}>
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="small">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="loading-box" role="status">
      <span className="spinner" aria-hidden="true" /> <span>{label}</span>
    </div>
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
        <button type="button" className="icon-button" aria-label="清除搜索" onClick={() => onChange("")}>
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

/* Structure --------------------------------------------------------------- */

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
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

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const headingId = useId();
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null
      );
      if (focusable.length === 0) {
        event.preventDefault();
        ref.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? "modal wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={headingId}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3 id={headingId}>{title}</h3>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="关闭对话框">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "确认",
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
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? "btn danger" : "btn primary"}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? "处理中…" : confirmLabel}
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
  return (
    <span className="connection-dot">
      <span className={kind === "idle" ? "dot" : `dot ${kind}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  "waiting-approval": "等待审批",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败",
  interrupted: "已中断",
  starting: "启动中",
  timed_out: "超时"
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusKind(status: string): "ok" | "warn" | "err" | "accent" {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "timed_out" || status === "interrupted") return "err";
  if (status === "stopped" || status === "waiting-approval") return "warn";
  return "accent";
}

export function StatusTag({ status }: { status: string }) {
  return <span className={`tag ${statusKind(status)}`}>{statusLabel(status)}</span>;
}

export function Tag({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "err" | "accent"; children: ReactNode }) {
  return <span className={tone === "neutral" ? "tag" : `tag ${tone}`}>{children}</span>;
}
