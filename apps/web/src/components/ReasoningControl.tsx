import { modelReasoningOptions, resolveModelReasoningSelection, type ModelDto, type ReasoningSelection } from "@llm-chat/contracts";
import { t, useLocale } from "../lib/i18n";

export interface ReasoningControlProps {
  model: ModelDto | undefined;
  value: ReasoningSelection | undefined;
  inherited?: ReasoningSelection;
  disabled?: boolean;
  onChange: (value: ReasoningSelection | undefined) => void;
}

export const reasoningKey = (selection: ReasoningSelection | undefined): string =>
  selection === undefined ? "inherit" : selection.mode === "default" ? "default" : `effort:${selection.value}`;
export const reasoningLabel = (selection: ReasoningSelection): string =>
  selection.mode === "default" ? t("reasoning.provider_default") : selection.value;
export const reasoningFromKey = (key: string): ReasoningSelection | undefined =>
  key === "inherit" ? undefined : key === "default" ? { mode: "default" } : { mode: "effort", value: key.slice(7) };

export function reasoningControl({ model, value, inherited }: Omit<ReasoningControlProps, "onChange">) {
  const profile = modelReasoningOptions(model);
  const current = resolveModelReasoningSelection(model, value ?? inherited ?? { mode: "default" });
  const following = value === undefined && inherited !== undefined;
  const inheritedLabel = inherited ? t("dialogs.follow_agent", {
    value1: reasoningLabel(resolveModelReasoningSelection(model, inherited))
  }) : undefined;
  const options = [
    { key: "default", label: t("reasoning.provider_default") },
    ...profile.values.map(effort => ({ key: `effort:${effort}`, label: effort }))
  ];
  return { options, current, key: reasoningKey(current), following, inheritedLabel,
    label: reasoningLabel(current) };
}

export function ReasoningSelect(props: ReasoningControlProps) {
  useLocale();
  const state = reasoningControl(props);
  return <select className="select" aria-label={t("ConnectionsView.reasoning_levels")} value={state.following ? "inherit" : state.key}
    disabled={props.disabled} onChange={event => props.onChange(reasoningFromKey(event.target.value))}>
    {state.inheritedLabel ? <option value="inherit">{state.inheritedLabel}</option> : null}
    {state.options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
  </select>;
}
