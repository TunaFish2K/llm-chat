import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { navigate, routes, useRoute } from "./router";

describe("router", () => {
  it("maps real paths to routes", () => {
    expect(routes.chat()).toBe("/");
    expect(routes.chat("abc")).toBe("/c/abc");
    expect(routes.chat("abc", "trajectory")).toBe("/c/abc/trajectory");
    expect(routes.conversationTasks("abc")).toBe("/c/abc/tasks");
    expect(routes.conversationTasks("abc", "t1")).toBe("/c/abc/tasks/t1");
    expect(routes.agents()).toBe("/agents");
    expect(routes.agents("a1")).toBe("/agents/a1");
    expect(routes.settings("tools")).toBe("/settings/tools");
  });

  it("keeps the useSyncExternalStore snapshot referentially stable", () => {
    window.history.pushState(null, "", "/agents");
    const { result, rerender } = renderHook(() => useRoute());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(first).toEqual({ name: "agents", agentId: null });
  });

  it("navigates with pushState and responds to popstate", async () => {
    window.history.pushState(null, "", "/");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "chat", conversationId: null, view: "chat", taskId: null });

    act(() => navigate("/c/conv-42"));
    expect(window.location.pathname).toBe("/c/conv-42");
    expect(result.current).toEqual({ name: "chat", conversationId: "conv-42", view: "chat", taskId: null });

    // Simulated browser back button; jsdom fires popstate asynchronously.
    act(() => {
      window.history.back();
    });
    await vi.waitFor(() => {
      expect(result.current).toEqual({ name: "chat", conversationId: null, view: "chat", taskId: null });
    });

    act(() => navigate("/settings/tools"));
    expect(result.current).toEqual({ name: "settings", section: "tools" });
  });

  it("parses conversation task routes and preserves legacy task links for redirect", () => {
    window.history.pushState(null, "", "/c/conv-42/tasks/task-7");
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "chat", conversationId: "conv-42", view: "tasks", taskId: "task-7" });

    act(() => navigate("/tasks/task-7"));
    expect(result.current).toEqual({ name: "tasks", taskId: "task-7" });
  });
});
