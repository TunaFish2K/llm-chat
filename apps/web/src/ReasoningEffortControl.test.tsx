import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { REASONING_EFFORTS, ReasoningEffortControl, reasoningEffortAt } from "./ReasoningEffortControl";

vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Slider: ({ value, onChange, onChangeComplete }: {
      value: number;
      onChange: (value: number) => void;
      onChangeComplete: (value: number) => void;
    }) => createElement("button", {
      role: "slider",
      "aria-valuenow": value,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "ArrowRight") {
          onChange(value + 1);
          onChangeComplete(value + 1);
        }
      }
    })
  };
});

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

describe("ReasoningEffortControl", () => {
  it("exposes every supported effort and previews and commits keyboard changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReasoningEffortControl value="medium" onChange={onChange} mobile />);
    expect(REASONING_EFFORTS).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    await user.click(screen.getByRole("button", { name: "推理强度：medium" }));
    expect(screen.getByText("medium", { selector: "code" })).toBeInTheDocument();
    const slider = await screen.findByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.getByText("high", { selector: "code" })).toBeInTheDocument();
  });

  it("syncs preview when the committed value changes and supports the saving state", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ReasoningEffortControl value="low" onChange={vi.fn()} saving />);
    expect(document.querySelector(".anticon-loading")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "推理强度：low" }));
    expect(screen.getByText("low", { selector: "code" })).toBeInTheDocument();
    rerender(<ReasoningEffortControl value="xhigh" onChange={vi.fn()} saving={false} placement="bottomLeft" />);
    expect(screen.getByText("xhigh", { selector: "code" })).toBeInTheDocument();
    expect(document.querySelector(".anticon-bulb")).toBeInTheDocument();
  });

  it("falls back to none for unsupported and absent slider indexes", () => {
    expect(reasoningEffortAt(5)).toBe("max");
    expect(reasoningEffortAt(99)).toBe("none");
    expect(reasoningEffortAt(undefined)).toBe("none");
    expect(reasoningEffortAt(null)).toBe("none");
  });
});
