import { t, useLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";

function getpresets() { return [[t("AccentPicker.blue"), "#018EEE"], [t("AccentPicker.orange"), "#E87542"], [t("AccentPicker.green"), "#22A06B"], [t("AccentPicker.purple"), "#9564E8"], [t("AccentPicker.pink"), "#E65998"], [t("AccentPicker.cyan"), "#009DA8"]]; }
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v / 100 * (1 - s / 100 * Math.max(0, Math.min(k, 4 - k, 1))); };
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
}
function toHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max * 100 : 0, max * 100];
}
export function AccentPicker({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  useLocale();
  const [hsv, setHsv] = useState(() => toHsv(value ?? "#018EEE"));
  const latest = useRef(hsv); latest.current = hsv;
  useEffect(() => { setHsv(toHsv(value ?? "#018EEE")); }, [value]);
  const color = hsvToHex(...hsv);
  return <div className="field accent-picker">
    <span className="field-label">{t("AccentPicker.accent_color")}</span>
    <div className="accent-presets">
      <button className="btn small" aria-pressed={!value} onClick={() => onChange(null)}>{t("AccentPicker.default_orange")}</button>
      {getpresets().map(([name, hex]) => <button key={hex} className="accent-swatch" aria-label={t("AccentPicker.label", { value1: (name) })} aria-pressed={value?.toLowerCase() === hex!.toLowerCase()}
        style={{ background: hex }} onClick={() => onChange(hex!)} />)}
    </div>
    <details><summary>{t("AccentPicker.custom_hsv_color")}</summary>
      <div className="hsv-square" aria-label={t("AccentPicker.saturation_and_brightness_palette")} style={{ backgroundColor: `hsl(${hsv[0]} 100% 50%)` }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const r = event.currentTarget.getBoundingClientRect(); setHsv([hsv[0], Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100)), Math.max(0, Math.min(100, 100 - (event.clientY - r.top) / r.height * 100))]); }}
        onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const r = event.currentTarget.getBoundingClientRect(); setHsv([latest.current[0], Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100)), Math.max(0, Math.min(100, 100 - (event.clientY - r.top) / r.height * 100))]); }}>
        <span style={{ left: `${hsv[1]}%`, top: `${100 - hsv[2]}%` }} />
      </div>
      {([t("AccentPicker.hue"), t("AccentPicker.saturation"), t("AccentPicker.brightness")] as const).map((label, index) => <label className="hsv-channel" key={label}>{label}
        <input type="range" min="0" max={index === 0 ? 359 : 100} value={hsv[index]} onChange={(event) => setHsv(hsv.map((v, i) => i === index ? Number(event.target.value) : v) as typeof hsv)} />
      </label>)}
      <div className="row"><span className="accent-swatch" style={{ background: color }} /><code>{color.toUpperCase()}</code>
        <button className="btn small" onClick={() => onChange(color)}>{t("AccentPicker.apply_color")}</button></div>
    </details>
  </div>;
}
