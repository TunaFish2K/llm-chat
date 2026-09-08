import { useState } from "react";
import { Popover, Slider } from "radix-ui";
import { Lightbulb } from "lucide-react";
import { INHERIT, REASONING_LEVELS } from "./model";
import type { ReasoningEffort } from "@llm-chat/contracts";

export function ReasoningPicker({ value, effective, inherited, levels, disabled, onChange }: {
  value: string; effective: ReasoningEffort; inherited: ReasoningEffort; levels: ReasoningEffort[]; disabled: boolean; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = [INHERIT, ...REASONING_LEVELS.filter((level) => levels.includes(level))];
  const index = Math.max(0, options.indexOf(value));
  const [preview, setPreview] = useState(index);
  const brightness = Math.max(0, REASONING_LEVELS.indexOf(effective));
  const label = (item: string) => item === INHERIT ? `跟随 Agent · ${inherited}` : item;
  return <Popover.Root open={open} onOpenChange={(next) => { setPreview(index); setOpen(next); }}>
    <Popover.Trigger asChild><button type="button" className="chip reasoning-trigger" disabled={disabled}
      aria-label={`推理档位：${label(value)}`} title={`推理档位：${label(value)}`}>
      <Lightbulb size={18} style={{ color: `color-mix(in srgb, var(--accent) ${25 + brightness * 15}%, var(--text-muted))`, fill: `color-mix(in srgb, var(--accent) ${brightness * 14}%, transparent)` }} />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reasoning-popover" side="top" sideOffset={10}>
      <Slider.Root aria-label="推理档位" orientation="vertical" min={0} max={options.length - 1} step={1}
        className="reasoning-slider" value={[preview]} onValueChange={([next]) => setPreview(next!)}
        onValueCommit={([next]) => onChange(options[next!]!)}>
        <Slider.Track className="reasoning-track"><Slider.Range className="reasoning-range" /></Slider.Track>
        <Slider.Thumb className="reasoning-thumb" aria-label="推理档位" aria-valuetext={label(options[preview]!)} />
      </Slider.Root>
      <div className="reasoning-labels">{[...options].reverse().map((item) => <button type="button" key={item}
        data-selected={item === options[preview] || undefined} onClick={() => { setPreview(options.indexOf(item)); onChange(item); }}>
        {label(item)}
      </button>)}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
