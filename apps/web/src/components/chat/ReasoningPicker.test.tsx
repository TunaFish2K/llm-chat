import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { makeModel } from "../../../test/fixtures";
import { ReasoningPicker } from "./ReasoningPicker";

const model = () => { const model = makeModel(); return { ...model, capabilities: { ...model.capabilities, reasoning: true }, detectedReasoningEfforts: ["minimal", "high", "none", "default"] }; };

it("shows native order and no false selection for unsupported inheritance", async () => {
  const onChange = vi.fn();
  render(<ReasoningPicker value={undefined} inherited={{ mode: "effort", value: "max" }} model={model()} onChange={onChange} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByRole("alert")).toHaveTextContent("当前模型不支持 max");
  expect(screen.getByRole("button", { name: /^跟随.*max/ })).toBeDisabled();
  expect(screen.queryByRole("button", { pressed: true })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "minimal" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: "effort", value: "minimal" });
});

it.each(["none", "default"])("distinguishes native %s from provider default", async (value) => {
  const onChange = vi.fn();
  render(<ReasoningPicker value={{ mode: "default" }} model={model()} onChange={onChange} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByRole("button", { name: "提供商默认" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.setup().click(screen.getByRole("button", { name: value }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: "effort", value });
});

it("offers only provider default for unknown models", async () => {
  render(<ReasoningPicker value={{ mode: "default" }} model={{ ...model(), detectedReasoningEfforts: null }} onChange={() => {}} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByText("未识别到原生档位。可在模型设置中手动补充。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "high" })).not.toBeInTheDocument();
});
