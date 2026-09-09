import { useLayoutEffect, useRef, useState } from "react";

export function useComposerLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ foldAgent: false, compact: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const media = window.matchMedia("(max-width: 640px)");
    const measure = () => {
      const width = element.clientWidth;
      if (!width) return;
      const count = 6;
      const size = media.matches ? 40 : 44;
      const gap = media.matches ? 4 : 10;
      const foldAgent = count * size + (count - 1) * gap > width;
      const remaining = count - Number(foldAgent);
      const compact = media.matches || remaining * size + (remaining - 1) * gap > width;
      setLayout((old) => old.foldAgent === foldAgent && old.compact === compact ? old : { foldAgent, compact });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    media.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); media.removeEventListener("change", measure); window.removeEventListener("resize", measure); };
  }, []);
  return { ref, ...layout };
}
