import { unified } from "unified";
import remarkParse from "remark-parse";

export type RichPart = { start: number; source: string; kind: "markdown" | "html" | "svg" };
type Node = { type: string; lang?: string | null; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
const parser = unified().use(remarkParse);
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const ROOT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+(?:html|svg)[^>]*>\s*)?<([a-z][\w:-]*)\b/i;

function sourceFallback(source: string): string {
  const longestFence = Math.max(2, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}svg\n${source}\n${fence}`;
}

function kindOf(source: string, language = ""): "html" | "svg" | null {
  const root = ROOT.exec(source.replace(/^(?:\s|<!--[\s\S]*?-->)+/, ""))?.[1]?.toLowerCase();
  if (root === "svg") {
    const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
    return parsed.documentElement.localName === "svg" && !parsed.querySelector("parsererror") ? "svg" : null;
  }
  return ["html", "htm"].includes(language) && /<[a-z][\s\S]*>/i.test(source) || root === "html" ? "html" : null;
}

/** Locate a complete raw HTML root without mistaking quoted attributes or script text for tags. */
function rawEnd(source: string, start: number): number | null {
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*\/?>/gi;
  tags.lastIndex = start;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source))) {
    if (!match[1]) continue;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    if (closing) {
      if (stack.at(-1) !== name) return null;
      stack.pop();
    } else if (!VOID.has(name) && !/\/\s*>$/.test(match[0])) {
      stack.push(name);
      if (name === "script" || name === "style") {
        const end = new RegExp(`</${name}\\s*>`, "gi"); end.lastIndex = tags.lastIndex;
        const close = end.exec(source);
        if (!close) return null;
        tags.lastIndex = end.lastIndex; stack.pop();
      }
    }
    if (!stack.length) return tags.lastIndex;
  }
  return null;
}

/** Extract only actual Markdown code/HTML nodes; inline code and escaped examples stay text. */
export function splitRichContent(text: string, streaming = false): RichPart[] {
  if (streaming) return [{ start: 0, source: text, kind: "markdown" }];
  const tree = parser.parse(text) as Node;
  const nodes: Node[] = [];
  const visit = (node: Node) => { if (["code", "html"].includes(node.type)) nodes.push(node); else node.children?.forEach(visit); };
  visit(tree);
  nodes.sort((a, b) => a.position!.start.offset! - b.position!.start.offset!);
  const found: Array<RichPart & { end: number }> = [];
  let consumed = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const start = node.position?.start.offset;
    let end = node.position?.end.offset;
    if (start === undefined || end === undefined || start < consumed) continue;
    let source = node.value ?? "";
    let kind: "html" | "svg" | null = null;
    if (node.type === "code") {
      const language = node.lang?.toLowerCase() ?? "";
      if (!["", "svg", "xml", "html", "htm"].includes(language)) continue;
      const raw = text.slice(start, end);
      const opening = /^[ \t]*(`{3,}|~{3,})/.exec(raw)?.[1];
      kind = kindOf(source, language);
      if (!kind) continue;
      const closedFence = opening && new RegExp(`(?:^|\\n)[ \\t>]*${opening[0]}{${opening.length},}[ \\t]*$`).test(raw);
      // A well-formed SVG is unambiguous even in an indented or unclosed final code block.
      if (!closedFence && kind !== "svg") continue;
      let document = source;
      // Adjacent CSS/JS fences belong to this document, in source order.
      while (index + 1 < nodes.length) {
        const next = nodes[index + 1]!;
        const a = next.position?.start.offset, b = next.position?.end.offset;
        const lang = next.lang?.toLowerCase();
        if (next.type !== "code" || a === undefined || b === undefined || text.slice(end, a).trim() || !["css", "js", "javascript"].includes(lang ?? "")) break;
        const fence = /^(`{3,}|~{3,})/.exec(text.slice(a, b))?.[1];
        if (!fence || !new RegExp(`(?:^|\\n)[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`).test(text.slice(a, b))) break;
        const code = next.value ?? "";
        const extra = lang === "css" ? `<style>${code.replace(/<\/style/gi, "<\\/style")}</style>` : `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
        document = /<\/body\s*>/i.test(document) ? document.replace(/<\/body\s*>/i, () => extra + "</body>") : document + extra;
        end = b; index++; kind = "html";
      }
      source = kind === "svg" ? source : document;
    } else {
      const root = ROOT.exec(text.slice(start))?.[1]?.toLowerCase();
      if (root === "content" || root === "statusblock") {
        const wrapperEnd = rawEnd(text, start);
        if (!wrapperEnd || !/<(?:style|script)\b/i.test(text.slice(start, wrapperEnd))) { consumed = wrapperEnd ?? end; continue; }
      }
      if (!root || !["content", "statusblock", "button", "form", "figure", "body", "svg", "html", "div", "section", "article", "main", "canvas", "style"].includes(root)) continue;
      const complete = rawEnd(text, start);
      if (complete === null) {
        if (root === "svg") {
          const closing = /<\/svg\s*>/i.exec(text.slice(start));
          const invalidEnd = closing ? start + closing.index + closing[0].length : end;
          found.push({ start, end: invalidEnd, kind: "markdown", source: sourceFallback(text.slice(start, invalidEnd)) });
          consumed = invalidEnd;
        }
        continue;
      }
      end = complete;
      // A raw document may put its CSS or scripts next to the visual root.
      while (true) {
        const suffix = /^\s*<(?:style|script|div|section|article|main|canvas|svg|button|form|figure)\b/i.exec(text.slice(end));
        if (!suffix) break;
        const nextEnd = rawEnd(text, end + suffix[0].indexOf("<"));
        if (nextEnd === null) break;
        end = nextEnd;
      }
      source = text.slice(start, end);
      kind = end > complete ? "html" : kindOf(source, root === "svg" ? "svg" : "html");
      if (!kind) {
        if (root === "svg") { found.push({ start, end, kind: "markdown", source: sourceFallback(source) }); consumed = end; }
        continue;
      }
    }
    // Do not repeatedly execute changing content while a response is being generated.
    found.push({ start, end, source, kind });
    consumed = end;
  }
  const parts: RichPart[] = [];
  let cursor = 0;
  for (const part of found) {
    if (part.start > cursor) parts.push({ start: cursor, source: text.slice(cursor, part.start), kind: "markdown" });
    parts.push(part);
    cursor = part.end;
  }
  if (cursor < text.length) parts.push({ start: cursor, source: text.slice(cursor), kind: "markdown" });
  return parts.length ? parts : [{ start: 0, source: text, kind: "markdown" }];
}
