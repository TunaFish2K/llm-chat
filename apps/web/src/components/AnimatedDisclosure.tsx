import { startTransition, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, useReducedMotion } from "../lib/motion";
import { useAnimationDuration } from "../lib/animation-preferences";
import { useHistoryRendering } from "../lib/history-rendering";
import { LoadingState } from "./ui";

/** Animate only an explicit toggle; streaming content keeps its natural height. */
export function AnimatedDisclosure({ className, state, summary, children, open: controlled, onOpenChange, lazy = false }: {
  className: string; state?: string; summary: ReactNode; children: ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void; lazy?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlled ?? localOpen;
  const [visible, setVisible] = useState(open);
  const [mounted, setMounted] = useState(!lazy);
  const allowed = useHistoryRendering();
  const reduced = useReducedMotion();
  const duration = useAnimationDuration("disclosure");
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  const revealAnimation = useRef(false);
  const id = useId();

  useEffect(() => {
    if (!lazy || mounted || !open || !allowed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { timer = setTimeout(() => startTransition(() => setMounted(true)), 0); });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [lazy, mounted, open, allowed]);

  useLayoutEffect(() => {
    const element = body.current, root = details.current;
    if (!element || !root) return;
    const shouldAnimate = (manual.current || (open && mounted && revealAnimation.current)) && !reduced && duration > 0;
    manual.current = false;
    if (mounted || !open) revealAnimation.current = false;
    if (!shouldAnimate) {
      element.style.height = "";
      setVisible(open);
      return;
    }
    const from = element.getBoundingClientRect().height;
    root.open = true;
    setVisible(true);
    const to = open ? element.scrollHeight : 0;
    let active = true;
    const animation = animate(element, { height: [from, to] }, { duration: duration / 1_000, ease: "easeOut" });
    void animation.then(() => {
      if (!active) return;
      element.style.height = "";
      setVisible(open);
    });
    return () => {
      active = false;
      const height = element.getBoundingClientRect().height;
      animation.stop();
      element.style.height = `${height}px`;
    };
  }, [open, reduced, mounted, duration]);

  return <details ref={details} className={className} data-state={state} data-expanded={open} open={visible}>
    <summary aria-expanded={open} aria-controls={id} onClick={event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      manual.current = true;
      if (lazy && !mounted && !open) revealAnimation.current = true;
      if (onOpenChange) onOpenChange(!open); else setLocalOpen(!open);
    }}>{summary}</summary>
    <div ref={body} id={id} className="disclosure-body" inert={!open ? true : undefined} aria-hidden={!open}>
      {mounted || !lazy ? children : open ? <LoadingState /> : null}
    </div>
  </details>;
}
