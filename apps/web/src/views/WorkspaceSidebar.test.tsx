import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appStore } from "../lib/app-state";
import { makeConversation } from "../../test/fixtures";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar", () => {
  it("keeps background tasks inside conversations instead of global navigation", () => {
    appStore.set({
      conversations: [makeConversation()],
      eventsConnected: true,
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

    expect(screen.getByRole("link", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "后台任务" })).not.toBeInTheDocument();
  });

  it("renders a focused navigation rail without indistinguishable conversation shortcuts", () => {
    appStore.set({
      conversations: [makeConversation({ title: "不会显示在收起栏中" })],
      eventsConnected: true
    });
    const onToggleCompact = vi.fn();

    render(
      <WorkspaceSidebar
        route={{ name: "agents", agentId: null }}
        compact
        onToggleCompact={onToggleCompact}
        pwa={{ supported: true, updateAvailable: false, installAvailable: true, offlineReady: false }}
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
    appStore.set({ conversations: [], eventsConnected: false });
    const onToggleCompact = vi.fn();

    render(
      <WorkspaceSidebar
        route={{ name: "settings", section: "general" }}
        compact={false}
        onToggleCompact={onToggleCompact}
        pwa={{ supported: false, updateAvailable: false, installAvailable: false, offlineReady: false }}
        onInstall={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "折叠会话栏" }));
    expect(onToggleCompact).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute("aria-current", "page");
  });
});
