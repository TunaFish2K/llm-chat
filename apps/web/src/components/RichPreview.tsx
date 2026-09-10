import { ActionButton } from "../lib/action-feedback";
import { memo, useEffect, useRef, useState } from "react";
import { useBackLayer } from "../lib/mobile-navigation";
import { toast, toastError } from "../lib/app-state";
import type { RichPart } from "../lib/rich-content";

export const RichPreview = memo(function RichPreview({ part }: { part: RichPart }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initializedFrame = useRef<HTMLIFrameElement | null>(null);
  const channel = useRef<MessageChannel | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [height, setHeight] = useState(180);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (ready) { setLoadFailed(false); return; }
    const timer = setTimeout(() => setLoadFailed(true), 10_000);
    return () => clearTimeout(timer);
  }, [ready, revision]);
  useBackLayer(expanded, () => setExpanded(false), 30);
  useEffect(() => () => { channel.current?.port1.close(); channel.current?.port2.close(); }, []);
  const title = part.kind === "svg" ? "SVG 预览" : "HTML 预览";
  const initialize = () => {
    if (!frame.current || initializedFrame.current === frame.current) return;
    initializedFrame.current = frame.current;
    channel.current?.port1.close(); channel.current?.port2.close();
    const next = new MessageChannel(); channel.current = next;
    next.port1.onmessage = (event) => {
      if (event.data?.type === "ready") setReady(true);
      if (event.data?.type === "height" && Number.isFinite(event.data.height)) setHeight(Math.max(64, Math.min(720, event.data.height + 16)));
    };
    const content = part.source;
    const defaults = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:8px;font-family:system-ui,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}img,svg,canvas{max-width:100%}svg{height:auto}</style>';
    const html = /<head\b[^>]*>/i.test(content) ? content.replace(/<head\b[^>]*>/i, (head) => head + defaults)
      : /<html\b[^>]*>/i.test(content) ? content.replace(/<html\b[^>]*>/i, (root) => root + '<head>' + defaults + '</head>')
      : '<!doctype html><html><head><meta charset="utf-8">' + defaults + '</head><body>' + content + '</body></html>';
    frame.current?.contentWindow?.postMessage({ type: "llm-chat:render", html }, "*", [next.port2]);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(part.source); toast("success", "源码已复制"); } catch (error) { toastError(error); } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([part.source], { type: part.kind === "svg" ? "image/svg+xml;charset=utf-8" : "text/html;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `preview.${part.kind === "svg" ? "svg" : "html"}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="rich-preview" data-expanded={expanded || undefined} aria-label={title}>
    <div className="rich-preview-toolbar">
      <span>{title}</span>
      <ActionButton type="button" aria-expanded={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}>{sourceOpen ? "隐藏源码" : "查看源码"}</ActionButton>
      <ActionButton type="button" onClick={() => copy()}>复制</ActionButton>
      <ActionButton type="button" onClick={download}>下载</ActionButton>
      <ActionButton type="button" onClick={() => { setReady(false); setLoadFailed(false); setRevision((value) => value + 1); }}>重新运行</ActionButton>
      <ActionButton type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}</ActionButton>
    </div>
    <iframe key={`${part.source}:${revision}`} ref={frame} title={title} src="/render-frame.html" sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={initialize} style={{ height: expanded ? "70dvh" : height }} />
    {!ready ? <span className="hint rich-preview-status">{loadFailed ? "预览未能加载，可重新运行或查看源码。" : "正在加载预览…"}</span> : null}
    {sourceOpen ? <pre className="rich-preview-source"><code>{part.source}</code></pre> : null}
  </section>;
});
