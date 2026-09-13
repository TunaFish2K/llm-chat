import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeConnection, makeModel } from "../../test/fixtures";
import { dismissBackLayer } from "../lib/mobile-navigation";
import { ModelPicker } from "./ModelPicker";

const model = makeModel({ displayName: "Alpha alpha", modelKey: "special.*[id]", protocol: "openai-responses" });
const connection = makeConnection({ name: "Primary cloud" });
const props = () => ({ value: model.id, models: [model, makeModel({ id: "other", displayName: "Other", modelKey: "other", protocol: "anthropic-messages" })], connections: [connection],
  label: "默认模型", onChange: vi.fn(), emptyOption: { label: "无默认模型", selected: false, onSelect: vi.fn() } });

describe("shared ModelPicker", () => {
  it.each([
    [" ALPHA ", "strong mark", ["Alpha", "alpha"]],
    [".*[id]", "small mark", [".*[id]"]],
    ["PRIMARY", "h3 mark", ["Primary"]],
    ["RESPONSES", "small mark", ["responses"]]
  ])("filters and highlights the same fields for %s", async (query, selector, matches) => {
    const user = userEvent.setup();
    render(<ModelPicker {...props()} />);
    await user.click(screen.getByRole("button", { name: "默认模型" }));
    await user.type(screen.getByRole("searchbox"), query.replaceAll("[", "[["));
    const panel = screen.getByRole("dialog");
    expect([...panel.querySelectorAll(selector)].map(mark => mark.textContent)).toEqual(matches);
    expect(panel.querySelectorAll(".model-group .model-option")).toHaveLength(query === "PRIMARY" ? 2 : 1);
  });

  it("shows only available image-input models and keeps the unconfigured option on empty results", async () => {
    const user = userEvent.setup();
    const input = props();
    const vision = makeModel({ id: "vision", displayName: "Vision", capabilities: { ...model.capabilities, imageInput: true } });
    render(<ModelPicker {...input} value={null} imageInputOnly models={[model, vision,
      { ...vision, id: "disabled", enabled: false }, { ...vision, id: "orphan", connectionId: "missing" }]} />);
    await user.click(screen.getByRole("button", { name: "默认模型" }));
    expect(screen.getByRole("dialog").querySelectorAll(".model-group .model-option")).toHaveLength(1);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Vision/ }));
    expect(input.onChange).toHaveBeenCalledWith("vision");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "默认模型" }));
    await user.type(screen.getByRole("searchbox"), "not found");
    expect(screen.getByText("没有匹配的可用模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "无默认模型" }));
    expect(input.emptyOption.onSelect).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "not-vision", "orphan", "deleted"])("preserves an unavailable %s selection until explicitly changed", async reason => {
    const input = props();
    const selected = { ...model, enabled: reason !== "disabled", connectionId: reason === "orphan" ? "missing" : connection.id };
    render(<ModelPicker {...input} value="model-1" imageInputOnly={reason === "not-vision"} models={reason === "deleted" ? [] : [selected]} />);
    expect(screen.getByRole("button", { name: "默认模型" })).toHaveTextContent(reason === "deleted" ? "model-1" : "Alpha alpha");
    expect(screen.getByRole("button", { name: "默认模型" })).toHaveTextContent("不可用");
    expect(input.onChange).not.toHaveBeenCalled();
    expect(input.emptyOption.onSelect).not.toHaveBeenCalled();
  });

  it("clears search on every dismissal and returns focus to the field", async () => {
    const user = userEvent.setup();
    const input = props();
    const { rerender } = render(<><ModelPicker {...input} /><button>Outside</button></>);
    for (const close of ["escape", "button", "outside", "back", "selection"]) {
      await user.click(screen.getByRole("button", { name: "默认模型" }));
      expect(screen.getByRole("searchbox")).toHaveValue("");
      await user.type(screen.getByRole("searchbox"), "alpha");
      if (close === "escape") await user.keyboard("{Escape}");
      if (close === "button") await user.click(screen.getByRole("button", { name: "关闭模型选择" }));
      if (close === "outside") await user.click(screen.getByRole("button", { name: "Outside" }));
      if (close === "back") act(() => { expect(dismissBackLayer()).toBe(true); });
      if (close === "selection") await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Alpha alpha/ }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      if (close !== "outside") await waitFor(() => expect(screen.getByRole("button", { name: "默认模型" })).toHaveFocus());
    }
    await user.click(screen.getByRole("button", { name: "默认模型" }));
    await user.type(screen.getByRole("searchbox"), "alpha");
    rerender(<ModelPicker {...input} disabled />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "默认模型" })).toBeDisabled();
    rerender(<ModelPicker {...input} />);
    await user.click(screen.getByRole("button", { name: "默认模型" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });
});
