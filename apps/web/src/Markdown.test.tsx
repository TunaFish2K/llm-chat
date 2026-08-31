import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

function fenced(language: string, source: string): string {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

describe("Markdown math", () => {
  it.each([
    ["dollar inline", String.raw`Euler: $e^{i\pi}+1=0$`],
    ["dollar display", "$$\nx^2 + y^2 = z^2\n$$"],
    ["parenthesis", String.raw`Euler: \(a+b\)`],
    ["brackets", String.raw`\[a^2+b^2=c^2\]`]
  ])("renders %s formulas", (_name, markdown) => {
    const { container } = render(<Markdown colorScheme="light">{markdown}</Markdown>);

    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders matrices, cases, and blackboard-bold symbols", () => {
    const markdown = [
      "$$",
      String.raw`\begin{matrix}1 & 2 \\ 3 & 4\end{matrix}`,
      "$$",
      "",
      String.raw`$f(x)=\begin{cases}x & x>0 \\ -x & x\le 0\end{cases}$`,
      "",
      String.raw`$\mathbb{R} \subset \mathbb{C}$`
    ].join("\n");
    const { container } = render(<Markdown colorScheme="light">{markdown}</Markdown>);

    expect(container.querySelectorAll(".katex")).toHaveLength(3);
    expect(container.querySelectorAll(".mtable").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll(".katex")[2]).toHaveTextContent("R⊂C");
  });

  it("keeps invalid and incomplete formulas safe and readable", () => {
    const invalid = String.raw`Invalid: $\notARealCommand{value}$`;
    const incomplete = String.raw`Incomplete: $\frac{1}{`;
    const { container, rerender } = render(<Markdown colorScheme="light">{invalid}</Markdown>);

    expect(container).toHaveTextContent("Invalid:");
    expect(container.querySelector(".katex")).toBeInTheDocument();

    rerender(<Markdown colorScheme="light">{incomplete}</Markdown>);
    expect(container).toHaveTextContent(incomplete);
  });

  it("converges from an incomplete streaming formula to completed math", () => {
    const { container, rerender } = render(<Markdown colorScheme="light" streaming>{String.raw`Answer: \(x^2`}</Markdown>);

    expect(container.querySelector(".katex")).not.toBeInTheDocument();

    rerender(<Markdown colorScheme="light">{String.raw`Answer: \(x^2\)`}</Markdown>);
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });
});

describe("Markdown code", () => {
  it.each([
    ["javascript", "const answer = 42;", "javascript"],
    ["ts", "const answer: number = 42;", "typescript"],
    ["py", "def answer():\n    return 42", "python"]
  ])("highlights %s code as %s", async (language, source, normalizedLanguage) => {
    const { container } = render(<Markdown colorScheme="light">{fenced(language, source)}</Markdown>);

    expect(screen.getByText(normalizedLanguage)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll("code .token").length).toBeGreaterThan(0));
  });

  it.each([
    ["mjs", "javascript"],
    ["c++", "cpp"],
    ["c#", "csharp"],
    ["golang", "go"],
    ["dockerfile", "docker"],
    ["yml", "yaml"],
    ["html", "markup"],
    ["kts", "kotlin"],
    ["rs", "rust"],
    ["rb", "ruby"],
    ["zsh", "bash"],
    ["md", "markdown"]
  ])("normalizes the %s alias to %s", (language, normalizedLanguage) => {
    render(<Markdown colorScheme="light">{fenced(language, "value")}</Markdown>);

    expect(screen.getByText(normalizedLanguage)).toBeInTheDocument();
  });

  it.each(["jsx", "tsx", "json", "css", "sql", "java", "c", "go", "rust", "php", "swift", "dart", "docker"])(
    "supports the direct %s language name",
    (language) => {
      render(<Markdown colorScheme="light">{fenced(language, "value")}</Markdown>);

      expect(screen.getByText(language)).toBeInTheDocument();
    }
  );

  it("keeps inline code as a native code element", () => {
    const { container } = render(<Markdown colorScheme="light">Use `const value = 1` inline.</Markdown>);

    expect(container.querySelector("p > code")).toHaveTextContent("const value = 1");
    expect(container.querySelector(".ant-codeHighlighter")).not.toBeInTheDocument();
  });

  it("falls back to plain code for unknown, parameterized, and language-free blocks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const markdown = [fenced("not-a-real-language", "unknown"), fenced("", "plain")].join("\n\n");
    const { container } = render(<Markdown colorScheme="dark">{markdown}</Markdown>);

    expect(container.querySelectorAll("pre > code")).toHaveLength(2);
    expect(container).toHaveTextContent("unknown");
    expect(container).toHaveTextContent("plain");
    expect(container.querySelector(".ant-codeHighlighter")).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses the built-in language header and copy action", async () => {
    const user = userEvent.setup();
    const source = "const copied = true;";
    const { container } = render(<Markdown colorScheme="light">{fenced("js extra-parameter", source)}</Markdown>);

    expect(screen.getByText("javascript")).toBeInTheDocument();
    const copyAction = screen.getByRole("button", { name: "复制代码" });
    expect(copyAction).toBeInTheDocument();

    await user.click(copyAction);
    await waitFor(() => expect(navigator.clipboard.readText()).resolves.toBe(`${source}\n`));
  });

  it("uses a transparent One Dark surface inside the dark code container", async () => {
    const { container } = render(<Markdown colorScheme="dark">{fenced("javascript", "const dark = true;")}</Markdown>);

    await waitFor(() => expect(container.querySelectorAll("code .token").length).toBeGreaterThan(0));
    const pre = container.querySelector(".ant-codeHighlighter-code pre");
    expect(pre).toHaveStyle({ background: "transparent", margin: "0px" });
    expect(pre).not.toHaveStyle({ background: "rgb(250, 250, 250)" });
  });
});

describe("Markdown safety", () => {
  it("sanitizes executable HTML", () => {
    const markdown = '<img src="x" onerror="window.__markdownXss = true"><script>window.__markdownXss = true</script>';
    const { container } = render(<Markdown colorScheme="light">{markdown}</Markdown>);

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toHaveAttribute("onerror");
    expect((window as Window & { __markdownXss?: boolean }).__markdownXss).toBeUndefined();
  });
});
