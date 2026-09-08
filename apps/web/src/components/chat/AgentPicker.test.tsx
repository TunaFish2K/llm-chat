import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { makeAgent } from "../../../test/fixtures";
import { AgentPicker } from "./AgentPicker";

it("searches descriptions, marks the current Agent, and selects with the keyboard", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<AgentPicker agents={[makeAgent(), makeAgent({ id: "second", name: "Writer", description: "写作助手", hasAvatar: true })]}
    value="agent-1" disabled={false} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "选择 Agent" });
  await user.click(trigger);
  expect(screen.getByRole("searchbox", { name: "搜索 Agent" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "测试助手" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "测试助手" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), "写作");
  expect(screen.queryByRole("button", { name: "测试助手" })).not.toBeInTheDocument();
  fireEvent.error(screen.getByRole("button", { name: "Writer" }).querySelector("img")!);
  await user.tab(); await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("second");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not summon the mobile keyboard and closes with Escape", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  const user = userEvent.setup();
  render(<AgentPicker agents={[makeAgent()]} value="agent-1" disabled={false} onChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: "选择 Agent" });
  await user.click(trigger);
  expect(screen.getByRole("searchbox")).not.toHaveFocus();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("retries an updated avatar after an earlier image failure", () => {
  const agent = makeAgent({ hasAvatar: true, updatedAt: 1 });
  const { rerender } = render(<AgentPicker agents={[agent]} value={agent.id} disabled={false} onChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: "选择 Agent" });
  fireEvent.error(trigger.querySelector("img")!);
  expect(trigger.querySelector("img")).toBeNull();
  rerender(<AgentPicker agents={[{ ...agent, updatedAt: 2 }]} value={agent.id} disabled={false} onChange={() => {}} />);
  expect(trigger.querySelector("img")).toHaveAttribute("src", `/api/agents/${agent.id}/avatar?t=2`);
});
