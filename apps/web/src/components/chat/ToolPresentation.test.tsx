import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ToolCallDto } from "@llm-chat/contracts";
import { ToolCallContent, ToolCallSummary } from "./ToolPresentation";

const call: ToolCallDto = { id: "call", index: 0, stepIndex: 0, name: "echo", arguments: '{"value":"raw"}', output: "raw result", error: null, approvalState: "completed", requiresApproval: false, startedAt: 1, completedAt: 2, artifacts: [] };
it("keeps retired Codex tool history readable with saved presentation or raw output", () => {
  const historical = { ...call, name: "codex_send", output: "historical Codex result" };
  const { rerender } = render(<ToolCallContent call={{ ...historical, presentation: { result: { detail: "Saved historical result" } } }} />);
  expect(screen.getByText("Saved historical result")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看原始数据" }));
  expect(screen.getByText("historical Codex result")).toBeVisible();
  rerender(<ToolCallContent call={historical} />);
  expect(screen.getByText("historical Codex result")).toBeVisible();
});
it("renders Markdown details, switches to original data, and falls back independently", () => {
  const { rerender } = render(<ToolCallContent call={{ ...call, presentation: { arguments: { detail: "**formatted args**" }, result: { summary: "short result" } } }} />);
  expect(screen.getByText("formatted args").closest('[data-streamdown="strong"]')).not.toBeNull();
  expect(screen.getByText("raw result")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看原始数据" }));
  expect(screen.queryByText("formatted args")).not.toBeInTheDocument();
  expect(screen.getByText(/"value": "raw"/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看格式化内容" }));
  expect(screen.getByText("formatted args")).toBeVisible();
  rerender(<ToolCallContent call={call} />);
  expect(screen.queryByRole("button", { name: "查看原始数据" })).not.toBeInTheDocument();
});
it("renders inline summaries with no images, controls or executable HTML", () => {
  const { container } = render(<ToolCallSummary call={{ ...call, presentation: { arguments: { summary: '**command**\n\n![secret](https://example.com/image.png)<script>alert(1)</script>' }, result: { summary: '`success`' } } }} />);
  expect(screen.getByText("command").closest('[data-streamdown="strong"]')).not.toBeNull();
  expect(screen.getByText("success")).toBeInTheDocument();
  expect(container.querySelector("img, button, script")).toBeNull();
});
