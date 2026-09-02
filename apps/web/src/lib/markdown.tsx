import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import { cjk } from "@streamdown/cjk";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

const INLINE_MATH = /\\\((.+?)\\\)/g;
const BLOCK_MATH = /\\\[(.+?)\\\]/gs;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Normalizes common model-produced LaTeX delimiters without touching code. */
export function normalizeMarkdown(value: string): string {
  const codeRanges: Array<[number, number]> = [];
  for (const match of value.matchAll(CODE)) {
    codeRanges.push([match.index, match.index + match[0].length]);
  }
  const insideCode = (offset: number) => codeRanges.some(([start, end]) => offset >= start && offset < end);
  return value
    .replace(INLINE_MATH, (source, body: string, offset: number) => insideCode(offset) ? source : `$${body}$`)
    .replace(BLOCK_MATH, (source, body: string, offset: number) => insideCode(offset) ? source : `$$${body}$$`);
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function SafeLink({ href, children, ...props }: ComponentProps<"a">) {
  if (!href || (!href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("mailto:"))) {
    return <span>{children}</span>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" title={textOf(children)}>
      {children}
    </a>
  );
}

function imageSource(src: string | undefined): string | null {
  if (!src) return null;
  if (/^\/api\/images\/[0-9a-f-]{36}\?v=[a-f0-9]{64}$/i.test(src)) return src;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `/api/image-proxy?url=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}

function SafeImage({ src, alt = "", ...props }: ComponentProps<"img">) {
  const safe = imageSource(src);
  if (!safe) return alt ? <span className="image-unavailable">[图片：{alt}]</span> : null;
  return (
    <a className="markdown-image-link" href={safe} target="_blank" rel="noopener noreferrer">
      <img {...props} src={safe} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    </a>
  );
}

const markdownComponents = { a: SafeLink, img: SafeImage } as unknown as Components;

/** Streaming-safe GFM, math and highlighted code. Raw HTML is never enabled. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const content = useMemo(() => normalizeMarkdown(text), [text]);
  return (
    <div className="markdown" data-streaming={streaming || undefined}>
      <Streamdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        plugins={{ cjk }}
        controls={{ code: true, mermaid: false }}
        isAnimating={streaming}
        components={markdownComponents}
      >
        {content}
      </Streamdown>
    </div>
  );
});
