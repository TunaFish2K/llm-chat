import { ChevronLeft, ChevronRight, Download, ExternalLink, LoaderCircle, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toastError } from "../lib/app-state";
import { t, useLocale } from "../lib/i18n";
import { closeImagePreview, downloadImage, imagePreviewStore, type PreviewImage } from "../lib/image-preview";
import { useBackLayer } from "../lib/mobile-navigation";
import { m, MotionProvider, Presence, useIsPresent, useReducedMotion } from "../lib/motion";
import { assetUrl } from "../lib/server-channel";
import { useStore } from "../lib/store";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const STEP = 1.5;
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface View { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 };

/** App-wide viewer for chat and image studio pictures: zoom, pan, pinch, swipe, download and the original file. */
export function ImagePreview() {
  const open = useStore(imagePreviewStore, (state) => state.open);
  return <Presence>{open ? <MotionProvider><Viewer /></MotionProvider> : null}</Presence>;
}

function Viewer() {
  useLocale();
  const images = useStore(imagePreviewStore, (state) => state.images);
  const [index, setIndex] = useState(() => imagePreviewStore.get().index);
  const [view, setView] = useState<View>(FIT);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [downloading, setDownloading] = useState(false);
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; view: View; distance: number; moved: boolean; backdrop: boolean } | null>(null);
  const lastTap = useRef(0);
  const image: PreviewImage | undefined = images[index];
  const many = images.length > 1;

  const close = useCallback(() => { if (present) closeImagePreview(); }, [present]);
  useBackLayer(true, close, 40);

  /** Keeps a zoomed picture covering the stage instead of drifting off screen. */
  const clamp = useCallback((next: View): View => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
    const box = stage.current?.getBoundingClientRect();
    const img = picture.current;
    if (!box || !img || scale === 1) return { scale, x: 0, y: 0 };
    const limitX = Math.max(0, (img.offsetWidth * scale - box.width) / 2);
    const limitY = Math.max(0, (img.offsetHeight * scale - box.height) / 2);
    return { scale, x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) };
  }, []);

  /** Zooms so the point under (clientX, clientY) stays where it is; without a point, around the centre. */
  const zoomTo = useCallback((scale: number, clientX?: number, clientY?: number, from = viewRef.current) => {
    const box = stage.current?.getBoundingClientRect();
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const px = box && clientX !== undefined ? clientX - box.left - box.width / 2 : 0;
    const py = box && clientY !== undefined ? clientY - box.top - box.height / 2 : 0;
    const ratio = target / from.scale;
    setView(clamp({ scale: target, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio }));
  }, [clamp]);

  const go = useCallback((step: number) => {
    if (!many) return;
    setIndex((value) => (value + step + images.length) % images.length);
  }, [many, images.length]);

  useEffect(() => { setView(FIT); setStatus("loading"); }, [index]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // React wheel listeners are passive, so the page would scroll instead of the picture zooming.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(viewRef.current.scale * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoomTo]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.querySelector<HTMLElement>(".image-preview-close")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root.current || event.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomTo(viewRef.current.scale * STEP); }
      else if (event.key === "-") { event.preventDefault(); zoomTo(viewRef.current.scale / STEP); }
      else if (event.key === "0") { event.preventDefault(); setView(FIT); }
      else if (event.key === "Tab" && root.current) {
        const nodes = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [close, go, zoomTo]);

  const midpoint = () => {
    const [a, b] = [...pointers.current.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Capturing a pointer that started on a button would steal its click.
    if (event.button !== 0 || !image || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pointers.current.size === 2 ? midpoint() : null;
    gesture.current = { startX: pinch?.x ?? event.clientX, startY: pinch?.y ?? event.clientY, view: viewRef.current,
      distance: pinch?.distance ?? 0, moved: Boolean(pinch), backdrop: !pinch && event.target === event.currentTarget };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    if (pointers.current.size === 2 && start.distance) {
      const pinch = midpoint();
      zoomTo(start.view.scale * pinch.distance / start.distance, pinch.x, pinch.y, start.view);
      return;
    }
    const dx = event.clientX - start.startX, dy = event.clientY - start.startY;
    if (Math.hypot(dx, dy) > 6) start.moved = true;
    if (start.view.scale > 1) setView(clamp({ ...start.view, x: start.view.x + dx, y: start.view.y + dy }));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const start = gesture.current;
    if (pointers.current.size === 1) {
      // One finger left after a pinch keeps panning from where the picture is now.
      const [rest] = [...pointers.current.values()];
      gesture.current = { startX: rest!.x, startY: rest!.y, view: viewRef.current, distance: 0, moved: true, backdrop: false };
      return;
    }
    gesture.current = null;
    if (!start || event.type === "pointercancel") return;
    const dx = event.clientX - start.startX, dy = event.clientY - start.startY;
    if (!start.moved) {
      // Pointer capture retargets click to the stage, so a tap beside the picture is recognised here instead.
      if (start.backdrop && start.view.scale === 1) { close(); return; }
      // A double tap or double click toggles between fitting the screen and a close look at that spot.
      if (event.timeStamp - lastTap.current < 300) {
        lastTap.current = 0;
        if (viewRef.current.scale > 1) setView(FIT); else zoomTo(2.5, event.clientX, event.clientY);
      } else lastTap.current = event.timeStamp;
      return;
    }
    if (start.view.scale === 1 && many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const download = async () => {
    if (!image || downloading) return;
    setDownloading(true);
    try { await downloadImage(image); } catch (cause) { toastError(cause); } finally { setDownloading(false); }
  };

  if (!image) return null;
  const source = assetUrl(image.url) ?? image.url;
  const original = image.sourceUrl ? assetUrl(image.sourceUrl) ?? image.sourceUrl : source;

  return <m.div ref={root} className="image-preview" role="dialog" aria-modal="true" aria-label={t("ImagePreview.title")}
    aria-hidden={!present || undefined} inert={!present ? true : undefined}
    initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1, transition: { duration: reduced ? 0 : 0.16 } }}
    exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.12 } }}>
    <header className="image-preview-bar">
      <span className="image-preview-name" title={image.fileName}>{image.fileName}</span>
      {many ? <span className="image-preview-count" aria-live="polite">{index + 1} / {images.length}</span> : null}
      <button type="button" className="image-preview-button image-preview-close" onClick={close}
        aria-label={t("ImagePreview.close")} title={t("ImagePreview.close")}><X size={20} /></button>
    </header>

    <div ref={stage} className="image-preview-stage" data-zoomed={view.scale > 1 || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <img key={source} ref={picture} src={source} alt={image.fileName} draggable={false} decoding="async"
        data-status={status} onLoad={() => setStatus("ready")} onError={() => setStatus("failed")}
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }} />
      {status === "loading" ? <LoaderCircle className="spin image-preview-state" size={28} role="status" aria-label={t("ImagePreview.loading")} /> : null}
      {status === "failed" ? <p className="image-preview-state" role="alert">{t("ImagePreview.load_failed")}</p> : null}
      {many ? <>
        <button type="button" className="image-preview-button image-preview-nav" data-side="left" onClick={() => go(-1)}
          aria-label={t("ImagePreview.previous")} title={t("ImagePreview.previous")}><ChevronLeft size={24} /></button>
        <button type="button" className="image-preview-button image-preview-nav" data-side="right" onClick={() => go(1)}
          aria-label={t("ImagePreview.next")} title={t("ImagePreview.next")}><ChevronRight size={24} /></button>
      </> : null}
    </div>

    <footer className="image-preview-bar image-preview-tools">
      <button type="button" className="image-preview-button" onClick={() => zoomTo(view.scale / STEP)} disabled={view.scale <= MIN_SCALE}
        aria-label={t("ImagePreview.zoom_out")} title={t("ImagePreview.zoom_out")}><ZoomOut size={18} /></button>
      <button type="button" className="image-preview-zoom" onClick={() => setView(FIT)}
        aria-label={t("ImagePreview.fit")} title={t("ImagePreview.fit")}>{Math.round(view.scale * 100)}%</button>
      <button type="button" className="image-preview-button" onClick={() => zoomTo(view.scale * STEP)} disabled={view.scale >= MAX_SCALE}
        aria-label={t("ImagePreview.zoom_in")} title={t("ImagePreview.zoom_in")}><ZoomIn size={18} /></button>
      <button type="button" className="image-preview-button" onClick={() => setView(FIT)} disabled={view.scale === 1}
        aria-label={t("ImagePreview.fit")} title={t("ImagePreview.fit")}><Maximize size={18} /></button>
      <span className="image-preview-divider" aria-hidden="true" />
      <button type="button" className="image-preview-button" onClick={() => void download()} disabled={downloading}
        aria-label={t("ImagePreview.download")} title={t("ImagePreview.download")}>
        {downloading ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
      </button>
      <a className="image-preview-button" href={original} target="_blank" rel="noopener noreferrer"
        aria-label={t("ImagePreview.open_original")} title={t("ImagePreview.open_original")}><ExternalLink size={18} /></a>
    </footer>
  </m.div>;
}
