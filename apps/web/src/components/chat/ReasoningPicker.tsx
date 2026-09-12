import { t, useLocale } from "../../lib/i18n";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useState } from "react";
import { Popover, Slider } from "radix-ui";
import { Lightbulb } from "lucide-react";
import { INHERIT, REASONING_LEVELS } from "./model";
import type { ReasoningEffort } from "@llm-chat/contracts";

export function ReasoningPicker({ value, effective, inherited, levels, disabled, onChange }: {
  value: string; effective: ReasoningEffort; inherited: ReasoningEffort; levels: ReasoningEffort[]; disabled: boolean; onChange: (value: string) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  const inheritedSupported = inherited === "none" || levels.includes(inherited);
  const effectiveSupported = effective === "none" || levels.includes(effective);
  const options = [...(inheritedSupported ? [INHERIT] : []), ...REASONING_LEVELS.filter((level) => levels.includes(level))];
  const index = Math.max(0, options.indexOf(value));
  const [preview, setPreview] = useState(index);
  const brightness = Math.max(0, REASONING_LEVELS.indexOf(effective));
  const label = (item: string) => item === INHERIT ? t("dialogs.follow_agent", { value1: (inherited) }) : item;
  return <Popover.Root open={open} onOpenChange={(next) => { setPreview(index); setOpen(next); }}>
    <Popover.Trigger asChild><button type="button" className="chip reasoning-trigger" disabled={disabled}
      aria-label={t("ReasoningPicker.reasoning_effort", { value1: (label(value)) })} title={t("ReasoningPicker.reasoning_effort", { value1: (label(value)) })}>
      <Lightbulb size={18} style={{ color: `color-mix(in srgb, var(--accent) ${25 + brightness * 15}%, var(--text-muted))`, fill: `color-mix(in srgb, var(--accent) ${brightness * 14}%, transparent)` }} />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reasoning-popover" side="top" sideOffset={10}>
      {!effectiveSupported ? <p role="alert" className="small">{t("ReasoningPicker.choose_supported_effort", { effort: effective, supported: levels.join(" / ") })}</p> : null}
      <Slider.Root aria-label={t("ConnectionsView.reasoning_levels")} orientation="vertical" min={0} max={options.length - 1} step={1}
        className="reasoning-slider" value={[preview]} onValueChange={([next]) => setPreview(next!)}
        onValueCommit={([next]) => onChange(options[next!]!)}>
        <Slider.Track className="reasoning-track"><Slider.Range className="reasoning-range" /></Slider.Track>
        <Slider.Thumb className="reasoning-thumb" aria-label={t("ConnectionsView.reasoning_levels")} aria-valuetext={label(options[preview]!)} />
      </Slider.Root>
      <div className="reasoning-labels">{[...options].reverse().map((item) => <button type="button" key={item}
        data-selected={item === options[preview] || undefined} onClick={() => { setPreview(options.indexOf(item)); onChange(item); }}>
        {label(item)}
      </button>)}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
