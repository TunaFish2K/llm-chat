import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Highlight, literalSearchPattern } from "./Highlight";

describe("literal search highlighting", () => {
  it.each([
    ["GPT gpt GpT", " gPt ", ["GPT", "gpt", "GpT"]],
    ["模型模型", "模型", ["模型", "模型"]],
    ["aaa", "aa", ["aa"]],
    ["a.*[x]+? a.*[x]+?", ".*[x]+?", [".*[x]+?", ".*[x]+?"]],
    ["<img onerror='bad'>", "<img", ["<img"]],
    ["🦊 model 🦊", "🦊", ["🦊", "🦊"]],
    ["Model", "   ", []],
    ["Model", "missing", []]
  ])("preserves text and highlights literal matches in %s", (text, query, expected) => {
    const { container } = render(<Highlight text={text} query={query} />);
    expect(container.textContent).toBe(text);
    expect([...container.querySelectorAll("mark")].map(mark => mark.textContent)).toEqual(expected);
    expect(container.querySelector("img")).toBeNull();
    const pattern = literalSearchPattern(query);
    if (pattern) expect(text.search(pattern) >= 0).toBe(expected.length > 0);
    else expect(query.trim()).toBe("");
  });
});
