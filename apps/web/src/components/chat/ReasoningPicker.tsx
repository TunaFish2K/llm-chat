import { t, useLocale } from "../../lib/i18n";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useState } from "react";
import { Popover } from "radix-ui";
import { Lightbulb } from "lucide-react";
import { reasoningControl, reasoningFromKey, type ReasoningControlProps } from "../ReasoningControl";

export function ReasoningPicker(props: ReasoningControlProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  const state = reasoningControl(props);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="chip reasoning-trigger" disabled={props.disabled}
      aria-label={t("ReasoningPicker.reasoning_effort", { value1: state.label })} title={t("ReasoningPicker.reasoning_effort", { value1: state.label })}>
      <Lightbulb size={18} />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reasoning-popover" side="top" sideOffset={10}>
      {state.warning ? <p className="small" role={state.invalid ? "alert" : undefined}>{state.warning}</p> : null}
      <div className="reasoning-labels">{state.options.map(option => <button type="button" key={option.key}
        disabled={option.disabled} aria-pressed={!state.invalid && option.key === state.key}
        data-selected={!state.invalid && option.key === state.key || undefined}
        onClick={() => { props.onChange(reasoningFromKey(option.key)); setOpen(false); }}>
        {option.label}
      </button>)}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
