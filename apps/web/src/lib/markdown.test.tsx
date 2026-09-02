import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeMarkdown, normalizeRichHtmlTags, sanitizeInlineStyle } from "./markdown";

describe("normalizeMarkdown", () => {
  it("normalizes model-style math delimiters without changing code", () => {
    expect(normalizeMarkdown("\\(x + y\\) and `\\(raw\\)`")).toBe("$x + y$ and `\\(raw\\)`");
  });

  it("normalizes Character Card wrappers without changing code examples", () => {
    expect(normalizeRichHtmlTags("<content>正文</content> ` <content>code</content> `"))
      .toBe('<div data-llm-section="content">正文</div> ` <content>code</content> `');
  });
});

describe("Markdown component", () => {
  it("renders GFM and fenced code with a copy control", () => {
    render(<Markdown text={"# 标题\n\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.querySelector(".markdown pre code")).toHaveTextContent("console.log(1)");
    expect(screen.getByRole("button", { name: /复制代码|Copy code/i })).toBeInTheDocument();
  });

  it("renders safe HTML while stripping executable elements and attributes", () => {
    render(<Markdown text={'安全文本<script>alert(1)</script><em onclick="alert(2)">斜体</em>'} />);
    expect(document.querySelector(".markdown script")).toBeNull();
    expect(document.querySelector(".markdown em")).toHaveTextContent("斜体");
    expect(document.querySelector(".markdown em")).not.toHaveAttribute("onclick");
    expect(screen.getByText(/安全文本/)).toBeInTheDocument();
  });

  it("renders Character Card content and status wrappers", () => {
    render(<Markdown text={'<content>正文</content><StatusBlock><div style="border: 1px dashed #000; padding: 10px; position: fixed"><details><summary>基本信息</summary><p>内容</p></details></div></StatusBlock>'} />);
    expect(document.querySelector('[data-llm-section="content"]')).toHaveTextContent("正文");
    expect(document.querySelector('[data-llm-section="status"] details')).toBeInTheDocument();
    const panel = document.querySelector<HTMLElement>('[data-llm-section="status"] > div')!;
    expect(panel.style.borderStyle).toBe("dashed");
    expect(panel.style.borderWidth).toBe("1px");
    expect(panel.getAttribute("style")).toContain("padding: 10px");
    expect(panel.getAttribute("style")).not.toContain("position");
  });

  it("filters unsafe inline CSS", () => {
    expect(sanitizeInlineStyle("font-size: 1.2em; background: url(https://x.test/a); z-index: 9; text-align: center"))
      .toBe("font-size: 1.2em; text-align: center");
  });

  it("opens safe links in a new tab and drops unsafe links", () => {
    const { rerender } = render(<Markdown text="[链接](https://example.com)" />);
    expect(screen.getByRole("link", { name: "链接" })).toHaveAttribute("rel", "noopener noreferrer");
    rerender(<Markdown text="[危险](javascript:alert(1))" />);
    expect(screen.queryByRole("link", { name: "危险" })).not.toBeInTheDocument();
  });

  it("renders hashed app images directly and proxies public remote images", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const hash = "a".repeat(64);
    const { rerender } = render(<Markdown text={`![本机图片](/api/images/${id}?v=${hash})`} />);
    expect(screen.getByRole("img", { name: "本机图片" })).toHaveAttribute("src", `/api/images/${id}?v=${hash}`);

    rerender(<Markdown text="![远程图片](https://example.com/picture.png?x=1)" />);
    expect(screen.getByRole("img", { name: "远程图片" })).toHaveAttribute(
      "src",
      `/api/image-proxy?url=${encodeURIComponent("https://example.com/picture.png?x=1")}`
    );
  });

  it("does not load arbitrary local or data image sources", () => {
    render(<Markdown text="![私有图片](file:///etc/passwd)" />);
    expect(screen.queryByRole("img", { name: "私有图片" })).not.toBeInTheDocument();
  });

  it("derives a useful link title from mixed formatted children", () => {
    render(<Markdown text="[hello **world**](https://example.com/docs)" />);
    expect(screen.getByRole("link", { name: "hello world" })).toHaveAttribute("title", "hello world");
  });

  it("marks streaming output for styling", () => {
    render(<Markdown text={"```js\nconsole.log(1)\n```"} />);
    const output = document.querySelector(".markdown");
    expect(output).not.toHaveAttribute("data-streaming");
  });
});
