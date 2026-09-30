import { useLayoutEffect, useRef, useState } from "react";

export function useComposerLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(() => ({ foldAgent: false, compact: window.matchMedia("(max-width: 640px)").matches }));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const media = window.matchMedia("(max-width: 640px)");
    let width = 0;
    const measure = () => {
      if (!width) return;
      const count = 6;
      const size = media.matches ? 40 : 44;
      const gap = media.matches ? 4 : 10;
      const foldAgent = count * size + (count - 1) * gap > width;
      const remaining = count - Number(foldAgent);
      const compact = media.matches || remaining * size + (remaining - 1) * gap > width;
      setLayout((old) => old.foldAgent === foldAgent && old.compact === compact ? old : { foldAgent, compact });
    };
    const fallbackMeasure = () => { width = element.clientWidth; measure(); };
    // ResizeObserver supplies the width without a synchronous layout read on mount.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      width = entries[0]?.contentRect.width ?? 0;
      measure();
    });
    observer?.observe(element);
    if (!observer) fallbackMeasure();
    media.addEventListener("change", measure);
    if (!observer) window.addEventListener("resize", fallbackMeasure);
    return () => { observer?.disconnect(); media.removeEventListener("change", measure); window.removeEventListener("resize", fallbackMeasure); };
  }, []);
  return { ref, ...layout };
}
