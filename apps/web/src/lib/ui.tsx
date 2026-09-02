import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="icon-btn-label">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="small">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button className="btn" onClick={onRetry}>
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
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>(focusableSelector)].filter(
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
    ref.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
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
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn ghost icon" onClick={onClose} aria-label="关闭对话框">
            <X size={18} aria-hidden="true" />
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
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
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

export function StatusDot({ kind, label }: { kind: "ok" | "warn" | "err" | "run" | "idle"; label: string }) {
  return (
    <span className="connection-dot">
      <span className={`dot ${kind === "idle" ? "" : kind}`} aria-hidden="true" />
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

export function StatusTag({ status }: { status: string }) {
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
