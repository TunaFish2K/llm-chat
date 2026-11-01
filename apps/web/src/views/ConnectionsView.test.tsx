import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionsView } from "./ConnectionsView";
import { appStore } from "../lib/app-state";
import { endpoints } from "../lib/api";
import { makeConnection, makeModel, makeSettings } from "../../test/fixtures";

function setup() {
  const connections = [makeConnection(), makeConnection({ id: "other", name: "Other" })];
  let models = [makeModel({ id: "a", displayName: "Alpha", enabled: false }),
    makeModel({ id: "b", displayName: "Beta", enabled: true }),
    makeModel({ id: "c", displayName: "Gamma", enabled: false }),
    makeModel({ id: "d", displayName: "Delta", connectionId: "other", enabled: false })];
  appStore.set({ connections, models });
  vi.spyOn(endpoints, "connections").mockResolvedValue(connections);
  vi.spyOn(endpoints, "models").mockImplementation(async () => models);
  vi.spyOn(endpoints, "conversations").mockResolvedValue([]);
  vi.spyOn(endpoints, "settings").mockResolvedValue(makeSettings());
  const batch = vi.spyOn(endpoints, "setModelsEnabled").mockImplementation(async ({ modelIds, enabled }) => {
    models = models.map(model => modelIds.includes(model.id) ? { ...model, enabled } : model);
    return models.filter(model => modelIds.includes(model.id));
  });
  render(<ConnectionsView />);
  return { batch, models };
}

it("selects across collapsed groups, inverts only the filter scope and enables only disabled selections", async () => {
  const { batch } = setup();
  fireEvent.click(screen.getByRole("checkbox", { name: "全选筛选结果" }));
  expect(screen.getByRole("button", { name: "启用 3" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "启用 3" }));
  await waitFor(() => expect(batch).toHaveBeenCalledWith({ modelIds: ["a", "c", "d"], enabled: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "取消选择" })).toBeDisabled());
  fireEvent.change(screen.getByRole("combobox", { name: "提供商连接" }), { target: { value: "other" } });
  fireEvent.click(screen.getByRole("button", { name: "反选" }));
  expect(screen.getByRole("checkbox", { name: "选择模型 Delta" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "禁用 1" }));
  await waitFor(() => expect(batch).toHaveBeenLastCalledWith({ modelIds: ["d"], enabled: false }));
});

it("supports Shift ranges and clears selection when the search changes", () => {
  setup();
  fireEvent.change(screen.getByRole("combobox", { name: "提供商连接" }), { target: { value: "connection-1" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "选择模型 Alpha" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择模型 Gamma" }), { shiftKey: true });
  expect(screen.getByRole("checkbox", { name: "选择模型 Beta" })).toBeChecked();
  expect(screen.getByRole("button", { name: "禁用 1" })).toBeEnabled();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Gamma" } });
  expect(screen.getByRole("checkbox", { name: "选择模型 Gamma" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "启用 0" })).toBeDisabled();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  expect(screen.getByRole("checkbox", { name: "选择模型 Alpha" })).not.toBeChecked();
  fireEvent.keyDown(screen.getByRole("checkbox", { name: "选择模型 Alpha" }), { key: "ArrowDown" });
  expect(screen.getByRole("checkbox", { name: "选择模型 Beta" })).toHaveFocus();
});

it("freezes controls during a batch and retains selection on failure", async () => {
  const { batch } = setup();
  let reject!: (error: Error) => void;
  batch.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  fireEvent.click(screen.getByRole("checkbox", { name: "全选筛选结果" }));
  fireEvent.click(screen.getByRole("button", { name: "启用 3" }));
  expect(screen.getByRole("searchbox")).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "全选筛选结果" })).toBeDisabled();
  await act(async () => reject(new Error("failed")));
  expect(screen.getByRole("checkbox", { name: "全选筛选结果" })).toBeChecked();
  expect(screen.getByRole("button", { name: "启用 3" })).toBeEnabled();
});

it("refreshes partially applied legacy batches before allowing another action", async () => {
  const { batch, models } = setup();
  batch.mockRejectedValue(new Error("second request failed"));
  vi.mocked(endpoints.models).mockResolvedValue(models.map(model => model.id === "a" ? { ...model, enabled: true } : model));
  fireEvent.click(screen.getByRole("checkbox", { name: "全选筛选结果" }));
  fireEvent.click(screen.getByRole("button", { name: "启用 3" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "启用 2" })).toBeEnabled());
  expect(appStore.get().models.find(model => model.id === "a")?.enabled).toBe(true);
  expect(endpoints.conversations).toHaveBeenCalled();
  expect(endpoints.settings).toHaveBeenCalled();
});
