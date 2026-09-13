import { t, useLocale } from "../../lib/i18n";
import { useBackLayer } from "../../lib/mobile-navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover, Slider } from "radix-ui";
import { Lightbulb } from "lucide-react";
import { reasoningControl, reasoningFromKey, type ReasoningControlProps } from "../ReasoningControl";

function ReasoningSlider({ state, disabled, onChange }: {
  state: ReturnType<typeof reasoningControl>;
  disabled: ReasoningControlProps["disabled"];
  onChange: ReasoningControlProps["onChange"];
}) {
  const selectedLabel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedLabel.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [state.key]);
  const options = state.options;
  const selectedIndex = options.findIndex(option => option.key === state.key);
  const [preview, setPreview] = useState<{ key: string; index: number } | null>(null);
  useEffect(() => setPreview(null), [state.key, disabled]);
  const index = !disabled && preview?.key === state.key ? preview.index : selectedIndex;
  const commit = (next: number) => {
    setPreview(null);
    if (!disabled && options[next]) onChange(reasoningFromKey(options[next].key));
  };
  const sliderDisabled = disabled || options.length < 2;
  return <>
    <div className="reasoning-steps" style={{ "--reasoning-count": options.length } as CSSProperties}>
      <div className="reasoning-rail"><Slider.Root orientation="vertical" min={0} max={Math.max(1, options.length - 1)} step={1}
        className="reasoning-slider" data-no-back-gesture
        disabled={sliderDisabled} value={[Math.max(0, index)]}
        onValueChange={([next]) => setPreview({ key: state.key, index: next! })} onValueCommit={([next]) => commit(next!)}
        onPointerCancel={() => setPreview(null)}>
        <Slider.Track className="reasoning-track"><Slider.Range className="reasoning-range" /></Slider.Track>
        <Slider.Thumb className="reasoning-thumb" tabIndex={options.length > 1 ? 0 : undefined} aria-label={t("ConnectionsView.reasoning_levels")}
          aria-disabled={sliderDisabled || undefined}
          aria-valuetext={options[index]!.label} />
      </Slider.Root></div>
      <div className="reasoning-labels">{[...options].reverse().map(option => <button type="button" key={option.key}
        ref={option.key === state.key ? selectedLabel : undefined} disabled={disabled} aria-pressed={option.key === options[index]?.key}
        data-selected={option.key === options[index]?.key || undefined}
        onClick={() => commit(options.indexOf(option))}>
        {option.label}
      </button>)}</div>
    </div>
  </>;
}

export function ReasoningPicker(props: ReasoningControlProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!open && !props.disabled && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
    }
  }, [open, props.disabled]);
  useBackLayer(open, () => setOpen(false));
  const state = reasoningControl(props);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className="chip reasoning-trigger" disabled={props.disabled}
      aria-label={t("ReasoningPicker.reasoning_effort", { value1: state.label })} title={t("ReasoningPicker.reasoning_effort", { value1: state.label })}>
      <Lightbulb size={18} />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reasoning-popover" side="top" sideOffset={10} collisionPadding={12}
      onOpenAutoFocus={event => {
        if (window.matchMedia("(pointer: coarse)").matches) event.preventDefault();
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        restoreFocus.current = Boolean(trigger.current?.disabled);
        if (!restoreFocus.current) trigger.current?.focus({ preventScroll: true });
      }}>
      <ReasoningSlider key={JSON.stringify([props.model?.id, state.options])}
        state={state} disabled={props.disabled} onChange={props.onChange} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
