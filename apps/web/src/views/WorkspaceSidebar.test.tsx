import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appStore } from "../lib/app-state";
import { makeConversation } from "../../test/fixtures";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar", () => {
  it("keeps background tasks inside conversations instead of global navigation", () => {
    appStore.set({
      conversations: [makeConversation()],
      eventsConnectionState: "connected",
      runningTasksByConversation: { "conv-1": 2 }
    });

    render(
      <WorkspaceSidebar
        route={{ name: "chat", conversationId: "conv-1", view: "tasks", taskId: null }}
        compact={false}
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false }}
        onInstall={vi.fn()}
      />
    );

    expect(screen.getByRole("link", { name: "Chat 首页" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "后台任务" })).not.toBeInTheDocument();
  });

  it("distinguishes the first connection from a reconnect", () => {
    appStore.set({ conversations: [], eventsConnectionState: "connecting" });
    const view = render(
      <WorkspaceSidebar
        route={{ name: "chat", conversationId: null, view: "chat", taskId: null }}
        compact={false}
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false }}
        onInstall={vi.fn()}
      />
    );

    expect(screen.getByTitle("正在连接事件流")).toHaveTextContent("连接中");
    act(() => appStore.set({ eventsConnectionState: "reconnecting" }));
    expect(screen.getByTitle("事件流断开，正在重连")).toHaveTextContent("重连中");
    view.unmount();
  });

  it("shows one active row per conversation family and sorts by descendant activity", () => {
    const root = makeConversation({ id: "root", title: "根会话", updatedAt: 10 });
    const branch = makeConversation({
      id: "branch",
      title: "根会话 · 分支",
      updatedAt: 100,
      forkedFrom: {
        conversationId: root.id,
        messageId: "message-1",
        messageOrdinal: 1,
        mode: "edit",
        greetingIndex: null,
        sourceGreetingIndex: null
      }
    });
    const other = makeConversation({ id: "other", title: "其他会话", updatedAt: 50 });
    appStore.set({ conversations: [other, root, branch], eventsConnectionState: "connected" });

    const { container } = render(
      <WorkspaceSidebar
        route={{ name: "chat", conversationId: branch.id, view: "chat", taskId: null }}
        compact={false}
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false }}
        onInstall={vi.fn()}
      />
    );

    const rows = [...container.querySelectorAll<HTMLElement>(".conversation-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("根会话");
    expect(rows[0]).toHaveAttribute("data-active", "true");
    expect(screen.queryByText("根会话 · 分支")).not.toBeInTheDocument();
  });
});
