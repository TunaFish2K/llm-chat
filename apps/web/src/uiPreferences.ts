export type ReasoningCollapsePolicy = "always-collapsed" | "collapse-on-answer" | "never-auto-collapse";

export interface UiPreferences {
  sidebarCollapsed: boolean;
  reasoningCollapsePolicy: ReasoningCollapsePolicy;
}

export const defaultUiPreferences: UiPreferences = {
  sidebarCollapsed: false,
  reasoningCollapsePolicy: "collapse-on-answer"
};

export function initialReasoningExpanded(
  policy: ReasoningCollapsePolicy,
  active: boolean,
  hasAnswer: boolean
): boolean {
  if (policy === "always-collapsed") return false;
  if (policy === "never-auto-collapse") return true;
  return active && !hasAnswer;
}
