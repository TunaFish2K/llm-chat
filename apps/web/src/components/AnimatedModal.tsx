import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t, useLocale } from "../lib/i18n";
import { useBackLayer } from "../lib/mobile-navigation";
import { MotionProvider, m, motionTiming, useIsPresent, useReducedMotion } from "../lib/motion";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; fullscreen?: boolean;
}
export function Modal(props: ModalProps) {
  return <MotionProvider><ModalContent {...props} /></MotionProvider>;
}
function ModalContent({ title, onClose, children, footer, wide, fullscreen }: ModalProps) {
  useLocale();
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = () => { if (present) onClose(); };
  useBackLayer(true, () => closeRef.current());

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current || event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!event.repeat) closeRef.current();
      } else if (event.key === "Tab" && ref.current) {
        if (ref.current.inert) { event.preventDefault(); return; }
        const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null && !element.closest('[inert]'));
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); ref.current.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const remaining = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const top = remaining[remaining.length - 1];
      if (previous?.isConnected && !previous.closest('[inert]') && (!top || top === ref.current || top.contains(previous))) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (present && !ref.current?.contains(document.activeElement)) {
      (ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current)?.focus({ preventScroll: true });
    }
  }, [present]);

  return <m.div className="modal-backdrop" data-exiting={!present || undefined}
    initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1, transition: { duration: reduced ? 0 : motionTiming.enter } }}
    exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTiming.exit } }}
    onClickCapture={event => { if (!present) { event.preventDefault(); event.stopPropagation(); } }}
    onMouseDown={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <m.div className={`modal${wide ? " wide" : ""}${fullscreen ? " fullscreen" : ""}`}
      ref={ref} role="dialog" aria-modal="true" aria-hidden={!present || undefined} aria-label={title} aria-labelledby={headingId} tabIndex={-1} inert={!present ? true : undefined}
      initial={{ y: reduced ? 0 : 4 }} animate={{ y: 0, transition: { duration: reduced ? 0 : motionTiming.enter } }}
      exit={{ y: reduced ? 0 : 4, transition: { duration: reduced ? 0 : motionTiming.exit } }}>
      <div className="modal-header"><h3 id={headingId}>{title}</h3>
        <button type="button" className="btn ghost icon" onClick={() => closeRef.current()} aria-label={t("index.close_dialog")}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-footer">{footer}</div> : null}
    </m.div>
  </m.div>;
}
