import { describe, expect, it } from "vitest";
import { splitRichContent } from "./rich-content";

const svg = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><circle cx="5" cy="5" r="4" fill="url(#g)"/></svg>';
describe("rich document recognition", () => {
  it("recognizes SVG fences with svg, xml, html and omitted labels", () => {
    for (const lang of ["svg", "xml", "html", ""]) {
      const parts = splitRichContent(`正文\n\n\`\`\`${lang}\n${svg}\n\`\`\`\n\n结尾`);
      expect(parts.map((part) => part.kind)).toEqual(["markdown", "svg", "markdown"]);
      expect(parts[1]!.source).toBe(svg);
      expect(parts[2]!.source).toContain("结尾");
    }
  });
  it("preserves inline code, escaped tags, malformed SVG and unfinished fences", () => {
    for (const text of [`\`${svg}\``, '&lt;svg&gt;hi&lt;/svg&gt;', '```svg\n<svg><broken></svg>\n```']) {
      expect(splitRichContent(text).every((part) => part.kind === "markdown")).toBe(true);
    }
  });
  it("combines adjacent HTML, CSS and JavaScript but leaves unrelated examples intact", () => {
    const text = '```html\n<button>Click</button>\n```\n\n```css\nbutton { color: red }\n```\n```js\ndocument.querySelector("button").onclick = () => alert(1)\n```\n\n说明\n```js\nconsole.log(1)\n```';
    const parts = splitRichContent(text);
    expect(parts[0]!.kind).toBe("html");
    expect(parts[0]!.source).toContain('<style>button { color: red }</style>');
    expect(parts[0]!.source).toContain('<script>document.querySelector');
    expect(parts[1]!.source).toContain('console.log(1)');
  });
  it("recognizes raw SVG and complete documents, respecting comments and quoted tags", () => {
    expect(splitRichContent(`图：${svg}`)[1]!.kind).toBe("svg");
    const html = '<!doctype html><html><head><style>body {color:red}</style></head><body><div title=">">Hi</div><script>const s = "<div>";</script></body></html>';
    expect(splitRichContent(html)[0]).toMatchObject({ kind: "html", source: html });
    expect(splitRichContent('<style>button{color:red}</style>\n<button>Hi</button>')[0]!.kind).toBe("html");
  });
  it("recognizes indented SVG and a complete SVG whose final fence was omitted", () => {
    expect(splitRichContent(`    ${svg}`)[0]!.kind).toBe("svg");
    expect(splitRichContent('```svg\n' + svg)[0]!.kind).toBe("svg");
    expect(splitRichContent('```svg\n<svg><path')[0]!.kind).toBe("markdown");
  });
  it("shows malformed raw SVG as source instead of dropping it", () => {
    const parts = splitRichContent('<svg><g></svg>');
    expect(parts[0]!.kind).toBe("markdown");
    expect(parts[0]!.source).toContain('```svg\n<svg><g></svg>');
  });
  it("does not run documents during streaming", () => {
    expect(splitRichContent('```html\n<script>alert(1)</script>\n```', true)[0]!.kind).toBe("markdown");
  });
});
