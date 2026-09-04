import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../lib/app-state";
import { makeBackgroundTask } from "../../test/fixtures";
import { ConversationTasksView } from "./TasksView";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  window.history.pushState(null, "", "/c/conv-1/tasks");
  appStore.set({ eventsConnectionState: "connected", runningTasksByConversation: {} });
});

describe("ConversationTasksView", () => {
  it("loads and links only the current conversation tasks", async () => {
    const task = makeBackgroundTask();
    const fetchMock = vi.fn((url: string) => Promise.resolve(json(
      url === "/api/background-tasks?conversationId=conv-1" ? [task] : []
    )));
    vi.stubGlobal("fetch", fetchMock);

    render(<ConversationTasksView conversationId="conv-1" taskId={null} />);

    const command = await screen.findByRole("button", { name: "pnpm test" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/background-tasks?conversationId=conv-1",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/background-tasks?scope=all",
      expect.anything()
    );

    fireEvent.click(command);
    expect(window.location.pathname).toBe("/c/conv-1/tasks/task-1");
  });

  it("canonicalizes a task detail to its owning conversation", async () => {
    const task = makeBackgroundTask({ id: "task-2", conversationId: "conv-2" });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/background-tasks?conversationId=conv-1") return Promise.resolve(json([]));
      if (url === "/api/background-tasks/task-2") return Promise.resolve(json({ task, events: [] }));
      if (url === "/api/background-tasks/task-2/output?cursor=0") {
        return Promise.resolve(json({ task, cursor: 0, earliestCursor: 0, gap: false, raw: "", text: "", screen: null }));
      }
      return Promise.resolve(json({}));
    }));

    render(<ConversationTasksView conversationId="conv-1" taskId="task-2" />);

    await waitFor(() => expect(window.location.pathname).toBe("/c/conv-2/tasks/task-2"));
  });
});
