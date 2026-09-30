import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { appStore } from "./lib/app-state";
import { makeAgent, makeConnection, makeModel, makeSettings } from "../test/fixtures";

vi.mock("./lib/app-state", async original => ({ ...await original<typeof import("./lib/app-state")>(), bootstrap: vi.fn(async () => {}) }));
vi.mock("./lib/pwa", async original => ({ ...await original<typeof import("./lib/pwa")>(), initPwa: vi.fn() }));

it("renders editable normal UI during bootstrap and retains it when the initial source becomes known", () => {
  history.replaceState(null, "", "/");
  localStorage.setItem("llm-chat.quick-tour.v1", "seen");
  appStore.set({ auth: "loading", sourceId: null, settings: null, agents: [], models: [], connections: [], conversations: [], messages: {}, toasts: [] });
  const view = render(<App />);
  const input = screen.getByLabelText("输入消息");
  expect(input).toBeEnabled();
  expect(view.container.querySelector(".boot-screen")).toBeNull();
  fireEvent.change(input, { target: { value: "Draft before bootstrap" } });
  act(() => appStore.set({ sourceId: "instance", settings: makeSettings(), agents: [makeAgent()], connections: [makeConnection()], models: [makeModel()] }));
  expect(screen.getByLabelText("输入消息")).toBe(input);
  expect(input).toHaveValue("Draft before bootstrap");
  expect(screen.getByRole("button", { name: "选择模型" })).toBeEnabled();
});
