import { useLayoutEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";

export function OverflowText({
  text,
  lines = 1,
  label,
  className = "",
  onOpen
}: {
  text: string;
  lines?: 1 | 2;
  label: string;
  className?: string;
  onOpen: () => void;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      setOverflowing(
        element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [lines, text]);

  return (
    <button
      type="button"
      className={`overflow-text ${className}`.trim()}
      data-lines={lines}
      data-overflowing={overflowing || undefined}
      aria-label={label}
      aria-haspopup="dialog"
      title={overflowing ? label : undefined}
      onClick={onOpen}
    >
      <span ref={textRef} className="overflow-text-copy">
        {text}
      </span>
      {overflowing ? (
        <span className="overflow-text-more" aria-hidden="true">
          <Maximize2 size={12} />
        </span>
      ) : null}
    </button>
  );
}
