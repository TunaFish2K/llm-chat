import { translate, type Locale, type MessageKey } from "@llm-chat/i18n";
import type { GenerationNotificationState } from "@llm-chat/contracts";

export type NotificationCommand = { locale?: Locale } & (
  | { kind: "sync" }
  | { kind: "foreground" }
  | { kind: "clear-conversations"; ids: string[] }
  | { kind: "generation"; sourceId: string; state: GenerationNotificationState; notify: boolean; revision: string });

export interface ConversationNotification {
  key: string;
  sourceId: string;
  conversationId: string;
  generationId: string;
  kind: "approval" | "terminal";
  title: string;
  body: string;
}

export function generationNotices(sourceId: string, state: GenerationNotificationState, locale: Locale = "zh-CN"): ConversationNotification[] {
  const t = (key: MessageKey, params?: Record<string, unknown>) => translate(locale, key, params);
  const common = { sourceId, conversationId: state.conversationId, generationId: state.generationId };
  if (state.status === "waiting-approval") {
    const steps = [...new Set(state.pendingTools.map((tool) => tool.stepIndex))];
    return steps.map((step) => {
      const tools = state.pendingTools.filter((tool) => tool.stepIndex === step);
      return { ...common, key: `${sourceId}:${state.generationId}:approval:${step}`, kind: "approval",
        title: t("notification_protocol.tools_need_approval"), body: t("notification_protocol.total", { value1: (state.conversationTitle), value2: (tools.map((tool) => tool.name).join(locale === "zh-CN" ? "、" : ", ")), value3: (tools.length) }).slice(0, 240) };
    });
  }
  const title = state.status === "completed" && state.stopReason !== "steered" ? t("notification_protocol.reply_completed")
    : state.status === "failed" ? t("notification_protocol.generation_failed") : state.status === "interrupted" ? t("notification_protocol.generation_interrupted") : null;
  return title ? [{ ...common, key: `${sourceId}:${state.generationId}:terminal`, kind: "terminal", title, body: state.conversationTitle }] : [];
}

export function conversationPath(id: string): string { return `/c/${encodeURIComponent(id)}`; }
