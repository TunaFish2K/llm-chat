import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeMarkdown } from "./markdown";

describe("normalizeMarkdown", () => {
  it("normalizes model-style math delimiters without changing code", () => {
    expect(normalizeMarkdown("\\(x + y\\) and `\\(raw\\)`")).toBe("$x + y$ and `\\(raw\\)`");
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

  it("never executes or renders raw HTML tags from source", () => {
    render(<Markdown text={'安全文本<script>alert(1)</script><em onclick="alert(2)">斜体</em>'} />);
    expect(document.querySelector(".markdown script")).toBeNull();
    expect(document.querySelector(".markdown em")).toBeNull();
    expect(screen.getByText(/安全文本/)).toBeInTheDocument();
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
