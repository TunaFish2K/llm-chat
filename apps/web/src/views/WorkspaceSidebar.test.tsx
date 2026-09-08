import { act, fireEvent, render, screen } from "@testing-library/react";
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
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false, updateStatus: "idle", updateError: null }}
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
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false, updateStatus: "idle", updateError: null }}
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
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false, updateStatus: "idle", updateError: null }}
        onInstall={vi.fn()}
      />
    );

    const rows = [...container.querySelectorAll<HTMLElement>(".conversation-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("根会话");
    expect(rows[0]).toHaveAttribute("data-active", "true");
    expect(screen.queryByText("根会话 · 分支")).not.toBeInTheDocument();
  });

  it("renders a focused navigation rail without indistinguishable conversation shortcuts", () => {
    appStore.set({
      conversations: [makeConversation({ title: "不会显示在收起栏中" })],
      eventsConnectionState: "connected"
    });
    const onToggleCompact = vi.fn();

    render(
      <WorkspaceSidebar
        route={{ name: "agents", agentId: null }}
        compact
        onToggleCompact={onToggleCompact}
        pwa={{ supported: true, updateAvailable: false, installAvailable: true, offlineReady: false, updateStatus: "idle", updateError: null }}
        onInstall={vi.fn()}
      />
    );

    expect(screen.queryByRole("navigation", { name: "最近会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "不会显示在收起栏中" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "搜索会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新会话" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装到设备" })).toBeInTheDocument();
    expect(screen.getByLabelText("事件流已连接")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(onToggleCompact).toHaveBeenCalledOnce();
  });

  it("offers the desktop collapse control from the expanded sidebar", () => {
    appStore.set({ conversations: [], eventsConnectionState: "reconnecting" });
    const onToggleCompact = vi.fn();

    render(
      <WorkspaceSidebar
        route={{ name: "settings", section: "general" }}
        compact={false}
        onToggleCompact={onToggleCompact}
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false, updateStatus: "idle", updateError: null }}
        onInstall={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "折叠会话栏" }));
    expect(onToggleCompact).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute("aria-current", "page");
  });
});
