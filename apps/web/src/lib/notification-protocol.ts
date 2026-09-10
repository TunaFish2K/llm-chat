import type { GenerationNotificationState } from "@llm-chat/contracts";

export type NotificationCommand =
  | { kind: "sync" }
  | { kind: "foreground" }
  | { kind: "clear-conversations"; ids: string[] }
  | { kind: "generation"; sourceId: string; state: GenerationNotificationState; notify: boolean; revision: string };

export interface ConversationNotification {
  key: string;
  sourceId: string;
  conversationId: string;
  generationId: string;
  kind: "approval" | "terminal";
  title: string;
  body: string;
}

export function generationNotices(sourceId: string, state: GenerationNotificationState): ConversationNotification[] {
  const common = { sourceId, conversationId: state.conversationId, generationId: state.generationId };
  if (state.status === "waiting-approval") {
    const steps = [...new Set(state.pendingTools.map((tool) => tool.stepIndex))];
    return steps.map((step) => {
      const tools = state.pendingTools.filter((tool) => tool.stepIndex === step);
      return { ...common, key: `${sourceId}:${state.generationId}:approval:${step}`, kind: "approval",
        title: "工具待审批", body: `${state.conversationTitle} · ${tools.map((tool) => tool.name).join("、")}（${tools.length} 项）`.slice(0, 240) };
    });
  }
  const title = state.status === "completed" && state.stopReason !== "steered" ? "回复已完成"
    : state.status === "failed" ? "生成失败" : state.status === "interrupted" ? "生成已中断" : null;
  return title ? [{ ...common, key: `${sourceId}:${state.generationId}:terminal`, kind: "terminal", title, body: state.conversationTitle }] : [];
}

export function conversationPath(id: string): string { return `/c/${encodeURIComponent(id)}`; }
