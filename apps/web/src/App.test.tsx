import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { endpoints } from "./lib/api";
import { appStore } from "./lib/app-state";
import { makeAgent, makeConnection, makeModel, makeSettings, makeConversation } from "../test/fixtures";

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

it("temporarily hides the shell while preserving the composer and sidebar instances", () => {
  history.replaceState(null, "", "/c/conv-1");
  localStorage.setItem("llm-chat.quick-tour.v1", "seen");
  vi.spyOn(endpoints, "messages").mockResolvedValue([]);
  vi.spyOn(endpoints, "queueState").mockResolvedValue({ items: [], paused: false });
  vi.spyOn(endpoints, "contextSummary").mockResolvedValue(null);
  appStore.set({ auth: "loading", sourceId: "reading", settings: makeSettings(), agents: [makeAgent()],
    models: [makeModel()], connections: [makeConnection()], conversations: [makeConversation()], messages: { "conv-1": [] }, toasts: [] });
  const view = render(<App />);
  const composer = view.container.querySelector(".composer")!;
  const sidebar = view.container.querySelector(".workspace-sidebar")!;
  const input = screen.getByLabelText("输入消息");
  fireEvent.change(input, { target: { value: "Preserved draft" } });
  const entry = screen.getByRole("button", { name: "阅读模式" });
  entry.focus(); fireEvent.click(entry);
  expect(view.container.querySelector(".app-frame")).toHaveAttribute("data-reading", "true");
  expect(view.container.querySelector(".composer")).toBe(composer);
  expect(composer).toHaveAttribute("hidden");
  expect(composer).toHaveAttribute("inert");
  expect(view.container.querySelector(".workspace-sidebar")).toBe(sidebar);
  expect(sidebar).toHaveAttribute("hidden");
  expect(screen.getByRole("button", { name: "退出阅读模式" })).toHaveClass("sr-only");
  fireEvent.keyDown(window, { key: "q" });
  expect(composer).not.toHaveAttribute("hidden");
  expect(sidebar).not.toHaveAttribute("hidden");
  expect(input).toHaveValue("Preserved draft");
  expect(entry).toHaveFocus();
});
