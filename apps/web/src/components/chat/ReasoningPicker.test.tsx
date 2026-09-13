import { useState } from "react";
import type { ReasoningSelection } from "@llm-chat/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { makeModel } from "../../../test/fixtures";
import { ReasoningPicker } from "./ReasoningPicker";
import { ReasoningSelect } from "../ReasoningControl";

const model = () => { const model = makeModel(); return { ...model, capabilities: { ...model.capabilities, reasoning: true }, detectedReasoningEfforts: ["minimal", "high", "none", "default"] }; };

it("selects the adapted inherited level without warnings or rewriting the preference", async () => {
  const onChange = vi.fn();
  render(<ReasoningPicker value={undefined} inherited={{ mode: "effort", value: "max" }} model={model()} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "推理档位：high" });
  expect(trigger).toHaveAttribute("title", "推理档位：high");
  await userEvent.setup().click(trigger);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText(/跟随 Agent/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "high" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "high");
  expect(onChange).not.toHaveBeenCalled();
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
  expect(screen.queryByText(/未识别|不支持/)).not.toBeInTheDocument();
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "默认");
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

it("adapts unsupported values without saving and allows explicitly choosing default with Home", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ReasoningPicker value={{ mode: "effort", value: "max" }} model={model()} onChange={onChange} />);
  await user.click(screen.getByRole("button"));
  const slider = screen.getByRole("slider");
  expect(slider).not.toHaveAttribute("aria-invalid");
  expect(slider).toHaveAttribute("aria-valuetext", "high");
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

it("restores a preference when switching back to a supporting model without calling onChange", async () => {
  const onChange = vi.fn();
  const props = { value: { mode: "effort", value: "max" } as ReasoningSelection, onChange };
  const full = { ...model(), detectedReasoningEfforts: ["low", "high", "max"] };
  const { rerender } = render(<ReasoningPicker {...props} model={full} />);
  await userEvent.setup().click(screen.getByRole("button"));
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "max");
  rerender(<ReasoningPicker {...props} model={model()} />);
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "high");
  rerender(<ReasoningPicker {...props} model={full} />);
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "max");
  expect(onChange).not.toHaveBeenCalled();
});

it("allows restoring inheritance in the conversation editor", async () => {
  const onChange = vi.fn();
  const inherited = { mode: "effort", value: "max" } as const;
  const { rerender } = render(<ReasoningSelect value={{ mode: "effort", value: "high" }} inherited={inherited} model={model()} onChange={onChange} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox"), "inherit");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  rerender(<ReasoningSelect value={undefined} inherited={inherited} model={model()} onChange={onChange} />);
  expect(screen.getByRole("combobox")).toHaveValue("inherit");
  expect(screen.getByRole("option", { name: "跟随 Agent · high" })).toBeEnabled();
});

it("shows effective values in editors without rewriting raw or inherited preferences", () => {
  const onChange = vi.fn();
  const requested = { mode: "effort", value: "max" } as const;
  const { rerender } = render(<ReasoningSelect value={requested} model={model()} onChange={onChange} />);
  expect(screen.getByRole("combobox")).toHaveValue("effort:high");
  expect(screen.queryByRole("option", { name: /max|不支持/ })).not.toBeInTheDocument();
  rerender(<ReasoningSelect value={undefined} inherited={requested} model={model()} onChange={onChange} />);
  expect(screen.getByRole("combobox")).toHaveValue("inherit");
  expect(screen.getByRole("option", { name: "跟随 Agent · high" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
