import { t, useLocale } from "./i18n";
import { OfflineAwareImage } from "../components/chat/atoms";
import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import { Streamdown, type Components, type StreamdownProps } from "streamdown";
import { cjk } from "@streamdown/cjk";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { harden } from "rehype-harden";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { RichPreview } from "../components/RichPreview";
import { splitRichContent } from "./rich-content";
import { MarkdownTable } from "../components/MarkdownTable";

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
  useLocale();
  const localFile = Boolean(href && /^\/api\/files\/[0-9a-f-]{36}\?v=[a-f0-9]{64}$/i.test(href));
  if (!href || (!localFile && !href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("mailto:"))) {
    return <span>{children}</span>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" title={textOf(children)} download={localFile || undefined}>
      {children}
    </a>
  );
}

function imageSource(src: string | undefined): string | null {
  if (!src) return null;
  if (/^\/api\/(?:images|files)\/[0-9a-f-]{36}\?v=[a-f0-9]{64}$/i.test(src)) return src;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `/api/image-proxy?url=${encodeURIComponent(url.toString())}`;
  } catch {
    return null;
  }
}

function SafeImage({ src, alt = "", ...props }: ComponentProps<"img">) {
  useLocale();
  const safe = imageSource(src);
  if (!safe) return alt ? <span className="image-unavailable">{t("markdown.image", { value1: (alt) })}</span> : null;
  return (
    <a className="markdown-image-link" href={safe} target="_blank" rel="noopener noreferrer">
      <OfflineAwareImage {...props} src={safe} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    </a>
  );
}

const SAFE_TAGS = ["div", "span", "small", "details", "summary"];
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

const safeHtmlSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SAFE_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "dataLlmSection"],
    details: [...(defaultSchema.attributes?.details ?? []), "open"]
  }
};

const SAFE_STYLE_PROPERTIES = new Set([
  "color", "background-color", "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-radius", "padding", "padding-top", "padding-right",
  "padding-bottom", "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "font-family", "font-size", "font-weight", "font-style", "text-align", "text-decoration", "list-style-type"
]);

function safeStyleValue(property: string, value: string): boolean {
  if (!value || value.length > 120 || /url\s*\(|expression\s*\(|var\s*\(|javascript:|@import|[{}\\]/i.test(value)) return false;
  if (!/^[\w\s#(),.%'"+\-\/]+$/.test(value)) return false;
  if (property === "text-align") return ["left", "right", "center", "justify", "start", "end"].includes(value);
  if (property === "font-style") return ["normal", "italic", "oblique"].includes(value);
  if (property === "font-weight") return /^(normal|bold|[1-9]00)$/.test(value);
  if (property === "list-style-type") return /^(disc|circle|square|decimal|lower-alpha|upper-alpha|none)$/.test(value);
  if (property === "font-size") {
    const match = /^(\d+(?:\.\d+)?)(px|em|rem|%)$/.exec(value);
    if (!match) return false;
    const amount = Number(match[1]);
    return match[2] === "px" ? amount >= 10 && amount <= 32
      : match[2] === "%" ? amount >= 60 && amount <= 200
      : amount >= 0.6 && amount <= 2;
  }
  for (const match of value.matchAll(/(-?\d+(?:\.\d+)?)(px|em|rem|%)/g)) {
    const amount = Math.abs(Number(match[1]));
    if ((match[2] === "px" && amount > 64) || ((match[2] === "em" || match[2] === "rem") && amount > 4) ||
      (match[2] === "%" && amount > 100)) return false;
  }
  return true;
}

export function sanitizeInlineStyle(value: string): string {
  return value.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 1) return [];
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const candidate = declaration.slice(separator + 1).trim();
    return SAFE_STYLE_PROPERTIES.has(property) && safeStyleValue(property, candidate)
      ? [`${property}: ${candidate}`]
      : [];
  }).join("; ");
}

function rehypeSafeInlineStyles() {
  return (tree: unknown) => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const current = node as { properties?: Record<string, unknown>; children?: unknown[] };
      if (current.properties && typeof current.properties.style === "string") {
        const style = sanitizeInlineStyle(current.properties.style);
        if (style) current.properties.style = style;
        else delete current.properties.style;
      }
      current.children?.forEach(visit);
    };
    visit(tree);
  };
}

const markdownComponents = {
  table: MarkdownTable,
  a: SafeLink,
  img: SafeImage
} as unknown as Components;

const inlineComponents: Components = {
  ...markdownComponents,
  p: "span", div: "span", h1: "span", h2: "span", h3: "span", h4: "span", h5: "span", h6: "span",
  pre: "span", blockquote: "span", ul: "span", ol: "span", li: "span", br: () => <span> </span>,
  img: ({ alt }) => <span>{alt}</span>, table: () => null, hr: () => null,
  details: "span", summary: "span"
};
const remarkPlugins = [remarkGfm, remarkMath];
const plugins = { cjk };
const blockControls = { code: true, mermaid: false, table: false };
const inlineControls = { code: false, mermaid: false, table: false };

/** Converts common Character Card wrappers into block elements before HTML parsing. */
export function normalizeRichHtmlTags(value: string): string {
  const transform = (source: string) => source
    .replace(/<\s*content\s*>/gi, '<div data-llm-section="content">')
    .replace(/<\s*\/\s*content\s*>/gi, "</div>")
    .replace(/<\s*statusblock\s*>/gi, '<div data-llm-section="status">')
    .replace(/<\s*\/\s*statusblock\s*>/gi, "</div>");
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(CODE)) {
    result += transform(value.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return result + transform(value.slice(cursor));
}

const richHtmlPlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
  rehypeRaw,
  rehypeSafeInlineStyles,
  [rehypeSanitize, safeHtmlSchema],
  [harden, {
    allowedImagePrefixes: ["*"],
    allowedLinkPrefixes: ["*"],
    allowedProtocols: ["http", "https", "mailto"],
    allowDataImages: false
  }],
  [rehypeKatex, { strict: false, trust: false }]
];

/** Streaming-safe GFM, math, highlighted code, and sanitized model-authored HTML. */
const MarkdownChunk = memo(function MarkdownChunk({ text, streaming = false, inline = false }: { text: string; streaming?: boolean; inline?: boolean }) {
  useLocale();
  const content = useMemo(() => normalizeRichHtmlTags(normalizeMarkdown(text)), [text]);
  return (
    <div className={`markdown${inline ? " markdown-inline" : ""}`} data-streaming={streaming || undefined}>
      <Streamdown
        translations={{ close: t("markdownControls.close"), copied: t("markdownControls.copied"), copyCode: t("markdownControls.copyCode"), copyLink: t("markdownControls.copyLink"), copyTable: t("markdownControls.copyTable"), copyTableAsCsv: t("markdownControls.copyTableAsCsv"), copyTableAsMarkdown: t("markdownControls.copyTableAsMarkdown"), copyTableAsTsv: t("markdownControls.copyTableAsTsv"), downloadDiagram: t("markdownControls.downloadDiagram"), downloadDiagramAsMmd: t("markdownControls.downloadDiagramAsMmd"), downloadDiagramAsPng: t("markdownControls.downloadDiagramAsPng"), downloadDiagramAsSvg: t("markdownControls.downloadDiagramAsSvg"), downloadFile: t("markdownControls.downloadFile"), downloadImage: t("markdownControls.downloadImage"), downloadTable: t("markdownControls.downloadTable"), downloadTableAsCsv: t("markdownControls.downloadTableAsCsv"), downloadTableAsMarkdown: t("markdownControls.downloadTableAsMarkdown"), exitFullscreen: t("markdownControls.exitFullscreen"), externalLinkWarning: t("markdownControls.externalLinkWarning"), imageNotAvailable: t("markdownControls.imageNotAvailable"), mermaidFormatMmd: t("markdownControls.mermaidFormatMmd"), mermaidFormatPng: t("markdownControls.mermaidFormatPng"), mermaidFormatSvg: t("markdownControls.mermaidFormatSvg"), openExternalLink: t("markdownControls.openExternalLink"), openLink: t("markdownControls.openLink"), resetView: t("markdownControls.resetView"), tableFormatCsv: t("markdownControls.tableFormatCsv"), tableFormatMarkdown: t("markdownControls.tableFormatMarkdown"), tableFormatTsv: t("markdownControls.tableFormatTsv"), viewFullscreen: t("markdownControls.viewFullscreen"), zoomIn: t("markdownControls.zoomIn"), zoomOut: t("markdownControls.zoomOut") }}
        remarkPlugins={remarkPlugins}
        rehypePlugins={richHtmlPlugins}
        plugins={plugins}
        controls={inline ? inlineControls : blockControls}
        isAnimating={streaming}
        normalizeHtmlIndentation
        components={inline ? inlineComponents : markdownComponents}
      >
        {content}
      </Streamdown>
    </div>
  );
});

export const Markdown = memo(function Markdown({ text, streaming = false, inline = false }: { text: string; streaming?: boolean; inline?: boolean }) {
  useLocale();
  const parts = useMemo(() => inline ? [{ start: 0, source: text, kind: "markdown" as const }] : splitRichContent(text, streaming), [text, streaming, inline]);
  return <>{parts.map((part) => part.kind === "markdown"
    ? <MarkdownChunk key={part.start} text={part.source} streaming={streaming} inline={inline} />
    : <RichPreview key={part.start} part={part} />)}</>;
});
