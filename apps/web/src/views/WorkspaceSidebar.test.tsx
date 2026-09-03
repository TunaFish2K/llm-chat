import { render, screen } from "@testing-library/react";
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

    expect(screen.getByRole("link", { name: "Chat 首页" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "聊天" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "后台任务" })).not.toBeInTheDocument();
  });
});
