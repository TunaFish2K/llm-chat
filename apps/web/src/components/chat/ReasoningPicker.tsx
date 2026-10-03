import { PopoverLayer } from "../../lib/motion";
import { t, useLocale } from "../../lib/i18n";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover } from "radix-ui";
import { Lightbulb } from "lucide-react";
import { reasoningControl, reasoningFromKey, type ReasoningControlProps } from "../ReasoningControl";

/** Vertical segmented column: segments fill from the bottom up to the chosen level. */
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
  const selectedIndex = Math.max(0, options.findIndex(option => option.key === state.key));
  const [preview, setPreview] = useState<{ key: string; index: number } | null>(null);
  useEffect(() => setPreview(null), [state.key, disabled]);
  const index = !disabled && preview?.key === state.key ? preview.index : selectedIndex;
  const commit = (next: number) => {
    setPreview(null);
    if (!disabled && options[next]) onChange(reasoningFromKey(options[next].key));
  };
  const sliderDisabled = disabled || options.length < 2;
  const last = options.length - 1;
  const indexAt = (element: HTMLElement, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const fromBottom = (rect.bottom - clientY) / Math.max(1, rect.height);
    return Math.min(last, Math.max(0, Math.floor(fromBottom * options.length)));
  };
  const keys: Record<string, (current: number) => number> = {
    ArrowUp: current => current + 1, ArrowRight: current => current + 1, PageUp: current => current + 1,
    ArrowDown: current => current - 1, ArrowLeft: current => current - 1, PageDown: current => current - 1,
    Home: () => 0, End: () => last
  };
  return <div className="reasoning-steps" style={{ "--reasoning-count": options.length } as CSSProperties}>
    <div className="reasoning-slider" role="slider" data-no-back-gesture
      tabIndex={options.length > 1 ? 0 : undefined}
      aria-label={t("ConnectionsView.reasoning_levels")} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={Math.max(1, last)} aria-valuenow={index} aria-valuetext={options[index]!.label}
      aria-disabled={sliderDisabled || undefined} data-disabled={sliderDisabled || undefined}
      onKeyDown={event => {
        const move = keys[event.key];
        if (!move) return;
        event.preventDefault();
        if (!sliderDisabled) commit(Math.min(last, Math.max(0, move(selectedIndex))));
      }}
      onPointerDown={event => {
        if (sliderDisabled || event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        setPreview({ key: state.key, index: indexAt(event.currentTarget, event.clientY) });
      }}
      onPointerMove={event => {
        if (preview?.key === state.key && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          setPreview({ key: state.key, index: indexAt(event.currentTarget, event.clientY) });
        }
      }}
      onPointerUp={event => { if (preview?.key === state.key) commit(indexAt(event.currentTarget, event.clientY)); }}
      onPointerCancel={() => setPreview(null)}
      onLostPointerCapture={() => setPreview(current => current && null)}>
      {options.map((option, position) => <span key={option.key} className="reasoning-segment"
        data-filled={position <= index || undefined} data-current={position === index || undefined} />).reverse()}
    </div>
    <div className="reasoning-labels">{[...options].reverse().map(option => <button type="button" key={option.key}
      ref={option.key === state.key ? selectedLabel : undefined} disabled={disabled} aria-pressed={option.key === options[index]?.key}
      data-selected={option.key === options[index]?.key || undefined}
      onClick={() => commit(options.indexOf(option))}>
      {option.label}
    </button>)}</div>
  </div>;
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
  const state = reasoningControl(props);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className="chip reasoning-trigger" disabled={props.disabled}
      aria-label={t("ReasoningPicker.reasoning_effort", { value1: state.label })} title={t("ReasoningPicker.reasoning_effort", { value1: state.label })}>
      <Lightbulb size={18} />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="reasoning-popover" side="top" sideOffset={10} collisionPadding={12}
      inert={!open ? true : undefined} aria-hidden={!open || undefined}
      onOpenAutoFocus={event => {
        if (window.matchMedia("(pointer: coarse)").matches) event.preventDefault();
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        const active = document.activeElement;
        if (active && active !== document.body && active !== trigger.current && !(event.target instanceof Element && event.target.contains(active))) return;
        restoreFocus.current = Boolean(trigger.current?.disabled);
        if (!restoreFocus.current) trigger.current?.focus({ preventScroll: true });
      }}><PopoverLayer open={open} onClose={() => setOpen(false)} />
      <ReasoningSlider key={JSON.stringify([props.model?.id, state.options])}
        state={state} disabled={props.disabled} onChange={props.onChange} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
