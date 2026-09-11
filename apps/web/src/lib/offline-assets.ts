import type { MessageDto } from "@llm-chat/contracts";

/** Only download image URLs already supported by the chat renderer. */
export function historyImageUrls(messages: MessageDto[]): string[] {
  const urls = new Set<string>();
  const add = (value: string) => {
    if (/^\/api\/(?:images|files)\/[\da-f-]{36}\?v=[\da-f]{64}$/i.test(value)) urls.add(value);
    else { try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol)) urls.add(`/api/image-proxy?url=${encodeURIComponent(url.href)}`); } catch {} }
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string" && (record.kind === "image" || String(record.mimeType).startsWith("image/"))) add(record.url);
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === "string" && ["text", "content", "detailMarkdown", "summary"].includes(key)) {
        for (const match of child.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) add(match[1]!);
        for (const match of child.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) add(match[1]!);
      } else if (typeof child === "object") visit(child);
    }
  };
  visit(messages);
  return [...urls];
}
