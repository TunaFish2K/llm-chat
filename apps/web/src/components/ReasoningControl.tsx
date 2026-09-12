import { modelReasoningOptions, type ModelDto, type ReasoningSelection } from "@llm-chat/contracts";
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
  const supported = (selection: ReasoningSelection) => selection.mode === "default" || profile.values.includes(selection.value);
  const current = value ?? inherited ?? { mode: "default" };
  const label = value ? reasoningLabel(value) : inherited ? t("dialogs.follow_agent", { value1: reasoningLabel(inherited) }) : reasoningLabel(current);
  const options = [
    ...(inherited ? [{ key: "inherit", label: t("dialogs.follow_agent", { value1: reasoningLabel(inherited) }), disabled: !supported(inherited) }] : []),
    { key: "default", label: t("reasoning.provider_default"), disabled: false },
    ...profile.values.map(effort => ({ key: `effort:${effort}`, label: effort, disabled: false }))
  ];
  const invalid = !supported(current);
  const warning = invalid && current.mode === "effort" ? t("ReasoningPicker.choose_supported_effort", {
    effort: current.value, supported: [t("reasoning.provider_default"), ...profile.values].join(" / ")
  }) : profile.source === "unknown" ? t("reasoning.unknown_hint") : null;
  return { options, key: reasoningKey(value ?? (inherited ? undefined : current)), label, invalid, warning };
}

export function ReasoningSelect(props: ReasoningControlProps) {
  useLocale();
  const state = reasoningControl(props);
  return <>
    <select className="select" aria-label={t("ConnectionsView.reasoning_levels")} value={state.key}
      disabled={props.disabled} onChange={event => props.onChange(reasoningFromKey(event.target.value))}>
      {!state.options.some(option => option.key === state.key) ? <option value={state.key} disabled>
        {t("ReasoningPicker.unsupported_effort", { effort: state.label })}
      </option> : null}
      {state.options.map(option => <option key={option.key} value={option.key} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {state.warning ? <p className="small muted" role={state.invalid ? "alert" : undefined}>{state.warning}</p> : null}
  </>;
}
