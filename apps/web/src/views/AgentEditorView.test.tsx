import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { agentRoleplayConfigSchema, characterCardV2Schema, type AgentDto } from "@llm-chat/contracts";
import { describe, expect, it, vi } from "vitest";
import { makeAgent } from "../../test/fixtures";
import { endpoints } from "../lib/api";
import * as appState from "../lib/app-state";
import { AgentEditorView } from "./AgentEditorView";

function setup() {
  let saved: AgentDto = {
    ...makeAgent(),
    card: characterCardV2Schema.parse({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Agent", system_prompt: "card override" } }),
    roleplay: agentRoleplayConfigSchema.parse({})
  };
  saved.execution.baseSystemPrompt = "my prompt";
  vi.spyOn(endpoints, "agent").mockImplementation(async (id) => structuredClone({ ...saved, id }));
  vi.spyOn(endpoints, "toolCatalog").mockResolvedValue([]);
  vi.spyOn(endpoints, "skills").mockResolvedValue([]);
  vi.spyOn(endpoints, "agents").mockImplementation(async () => [saved]);
  const update = vi.spyOn(endpoints, "updateAgent").mockImplementation(async (_id, patch) => {
    saved = { ...saved, ...patch } as AgentDto;
    return structuredClone(saved);
  });
  const defaults = vi.spyOn(endpoints, "agentDefaults").mockResolvedValue({ baseSystemPrompt: "current default" });
  return { update, defaults };
}

async function openReset() {
  fireEvent.click(await screen.findByRole("button", { name: "重置默认" }));
  return screen.getByRole("dialog");
}

function deferred() {
  let resolve!: (value: { baseSystemPrompt: string }) => void;
  const promise = new Promise<{ baseSystemPrompt: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Agent base prompt reset", () => {
  it("requires confirmation and explicit save, preserving other draft fields", async () => {
    const { update, defaults } = setup();
    const view = render(<AgentEditorView agentId="agent-1" />);
    let dialog = await openReset();
    expect(defaults).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByText("my prompt")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Draft name" } });
    dialog = await openReset();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置默认" }));
    await screen.findByText("current default");
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByLabelText("名称")).toHaveValue("Draft name");
    expect(screen.getByText("card override")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      execution: expect.objectContaining({ baseSystemPrompt: "current default" }),
      card: expect.objectContaining({ data: expect.objectContaining({ name: "Draft name", system_prompt: "card override" }) })
    })));
    await screen.findByRole("button", { name: "已保存" });
    view.unmount();
    render(<AgentEditorView agentId="agent-1" />);
    expect(await screen.findByText("current default")).toBeInTheDocument();
  });

  it("preserves the prompt after a failed request and allows retry", async () => {
    const { defaults, update } = setup();
    const error = new Error("unavailable");
    defaults.mockRejectedValueOnce(error);
    const notify = vi.spyOn(appState, "toastError").mockImplementation(() => {});
    render(<AgentEditorView agentId="agent-1" />);
    const dialog = await openReset();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置默认" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(error));
    expect(screen.getByText("my prompt")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置默认" }));
    expect(await screen.findByText("current default")).toBeInTheDocument();
  });

  it.each(["cancel", "switch"])("ignores a pending response after %s and prevents duplicate requests", async (action) => {
    const { defaults, update } = setup();
    const pending = deferred();
    defaults.mockReturnValue(pending.promise);
    const view = render(<AgentEditorView agentId="agent-1" />);
    const dialog = await openReset();
    const confirm = within(dialog).getByRole("button", { name: "重置默认" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(defaults).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    if (action === "cancel") fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    else view.rerender(<AgentEditorView agentId="agent-2" />);
    await act(async () => { pending.resolve({ baseSystemPrompt: "late default" }); });
    expect(await screen.findByText("my prompt")).toBeInTheDocument();
    expect(screen.queryByText("late default")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
