import { useEffect, useRef } from "react";

export function SelectionCheckbox({ label, checked, mixed = false, disabled = false, onToggle }: {
  label: string; checked: boolean; mixed?: boolean; disabled?: boolean; onToggle: (range: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="selection-hit-area"><input ref={ref} type="checkbox" className="selection-checkbox" aria-label={label}
    aria-checked={mixed ? "mixed" : checked} checked={checked} disabled={disabled} readOnly
    onClick={event => onToggle(event.shiftKey)} onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key) || !event.currentTarget.closest("tbody")) return;
      const rows = [...(event.currentTarget.closest(".settings-panels")?.querySelectorAll<HTMLInputElement>("tbody .selection-checkbox:not(:disabled)") ?? [])];
      const index = rows.indexOf(event.currentTarget);
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) { event.preventDefault(); next.focus(); }
    }} /></label>;
}
