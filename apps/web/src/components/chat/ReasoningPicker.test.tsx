import { useState } from "react";
import type { ReasoningSelection } from "@llm-chat/contracts";
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
  expect(screen.getByRole("button", { name: "默认" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.setup().click(screen.getByRole("button", { name: value }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: "effort", value });
});

it("offers only provider default for unknown models", async () => {
  render(<ReasoningPicker value={{ mode: "default" }} model={{ ...model(), detectedReasoningEfforts: null }} onChange={() => {}} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByText("未识别到原生档位。可在模型设置中手动补充。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "high" })).not.toBeInTheDocument();
});

function ControlledPicker({ onChange }: { onChange: (value: ReasoningSelection | undefined) => void }) {
  const [value, setValue] = useState<ReasoningSelection | undefined>({ mode: "default" });
  return <ReasoningPicker value={value} model={model()} onChange={next => { setValue(next); onChange(next); }} />;
}

it("restores the vertical slider with native stops, keyboard selection and an open popover", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ControlledPicker onChange={onChange} />);
  await user.click(screen.getByRole("button"));
  const slider = screen.getByRole("slider");
  expect(slider).toHaveAttribute("aria-orientation", "vertical");
  expect(slider).toHaveAttribute("aria-valuemax", "4");
  expect(slider).toHaveAttribute("aria-valuetext", "默认");
  expect(onChange).not.toHaveBeenCalled();
  slider.focus();
  await user.keyboard("{ArrowUp}");
  expect(onChange).toHaveBeenLastCalledWith({ mode: "effort", value: "minimal" });
  expect(slider).toHaveFocus();
  await user.keyboard("{End}");
  expect(onChange).toHaveBeenLastCalledWith({ mode: "effort", value: "default" });
  await user.keyboard("{Home}");
  expect(onChange).toHaveBeenLastCalledWith({ mode: "default" });
  await user.click(screen.getByRole("button", { name: "none" }));
  expect(slider).toBeVisible();
  expect(slider).toHaveAttribute("aria-valuetext", "none");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toHaveFocus();
});

it("marks unsupported values as unselected and allows choosing default with Home", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ReasoningPicker value={{ mode: "effort", value: "max" }} model={model()} onChange={onChange} />);
  await user.click(screen.getByRole("button"));
  const slider = screen.getByRole("slider");
  expect(slider).toHaveAttribute("aria-invalid", "true");
  expect(slider).toHaveAttribute("aria-valuetext", expect.stringContaining("max"));
  expect(onChange).not.toHaveBeenCalled();
  slider.focus();
  await user.keyboard("{Home}");
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: "default" });
});

it("disables a single-stop slider and resets its range when the model changes", async () => {
  const onChange = vi.fn();
  const props = { value: { mode: "default" } as ReasoningSelection, onChange };
  const { rerender } = render(<ReasoningPicker {...props} model={{ ...model(), detectedReasoningEfforts: null }} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByRole("slider")).toHaveAttribute("aria-disabled", "true");
  rerender(<ReasoningPicker {...props} model={model()} />);
  expect(screen.getByRole("slider")).not.toHaveAttribute("aria-disabled");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "4");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "默认");
  expect(onChange).not.toHaveBeenCalled();
});

it("blocks changes while saving and restores trigger focus after closing during a save", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const props = { value: { mode: "default" } as ReasoningSelection, model: model(), onChange };
  const { rerender } = render(<ReasoningPicker {...props} />);
  await user.click(screen.getByRole("button"));
  const slider = screen.getByRole("slider");
  slider.focus();
  rerender(<ReasoningPicker {...props} disabled />);
  expect(slider).toHaveFocus();
  await user.keyboard("{End}");
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  rerender(<ReasoningPicker {...props} />);
  expect(screen.getByRole("button")).toHaveFocus();
});
