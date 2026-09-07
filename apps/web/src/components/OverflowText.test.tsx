import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverflowText } from "./OverflowText";

describe("OverflowText", () => {
  it("shows its detail affordance only when the rendered text overflows", async () => {
    const onOpen = vi.fn();
    render(<OverflowText text="完整路径" label="查看完整路径" onOpen={onOpen} />);
    const trigger = screen.getByRole("button", { name: "查看完整路径" });
    const copy = trigger.querySelector<HTMLElement>(".overflow-text-copy");
    expect(copy).not.toBeNull();
    expect(trigger).not.toHaveAttribute("data-overflowing");
    expect(trigger.querySelector(".overflow-text-more")).toBeNull();

    Object.defineProperty(copy, "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(copy, "scrollWidth", { configurable: true, value: 160 });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(trigger).toHaveAttribute("data-overflowing", "true"));
    expect(trigger.querySelector(".overflow-text-more")).not.toBeNull();
    await userEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
