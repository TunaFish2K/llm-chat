import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReasoningPicker } from "./ReasoningPicker";
import { INHERIT } from "./model";

it("warns about an unsupported inherited effort and offers only native values", async () => {
  const onChange = vi.fn();
  render(<ReasoningPicker value={INHERIT} effective="max" inherited="max"
    levels={["low", "medium", "high", "xhigh"]} disabled={false} onChange={onChange} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByRole("alert")).toHaveTextContent("当前模型不支持 max");
  expect(screen.queryByRole("button", { name: "max" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^跟随.*max/ })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "xhigh" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("xhigh");
});

it("keeps a supported inherited effort selectable", async () => {
  render(<ReasoningPicker value={INHERIT} effective="high" inherited="high"
    levels={["low", "medium", "high", "xhigh"]} disabled={false} onChange={() => {}} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^跟随 Agent · high$/ }).textContent).toBeTruthy();
});
