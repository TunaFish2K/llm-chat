import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motionTiming, useReducedMotion } from "../lib/motion";

/** Animate only an explicit toggle; streaming content keeps its natural height. */
export function AnimatedDisclosure({ className, state, summary, children, open: controlled, onOpenChange }: {
  className: string; state?: string; summary: ReactNode; children: ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlled ?? localOpen;
  const [visible, setVisible] = useState(open);
  const reduced = useReducedMotion();
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  const id = useId();

  useLayoutEffect(() => {
    const element = body.current, root = details.current;
    if (!element || !root) return;
    const shouldAnimate = manual.current && !reduced;
    manual.current = false;
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
    const animation = animate(element, { height: [from, to] }, { duration: motionTiming.enter, ease: "easeOut" });
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
  }, [open, reduced]);

  return <details ref={details} className={className} data-state={state} data-expanded={open} open={visible}>
    <summary aria-expanded={open} aria-controls={id} onClick={event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      manual.current = true;
      if (onOpenChange) onOpenChange(!open); else setLocalOpen(!open);
    }}>{summary}</summary>
    <div ref={body} id={id} className="disclosure-body" inert={!open ? true : undefined} aria-hidden={!open}>
      {children}
    </div>
  </details>;
}
