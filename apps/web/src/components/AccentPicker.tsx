import { useEffect, useRef, useState } from "react";

const presets = [["蓝", "#018EEE"], ["橙", "#E87542"], ["绿", "#22A06B"], ["紫", "#9564E8"], ["粉", "#E65998"], ["青", "#009DA8"]];
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
  const [hsv, setHsv] = useState(() => toHsv(value ?? "#018EEE"));
  const latest = useRef(hsv); latest.current = hsv;
  useEffect(() => { setHsv(toHsv(value ?? "#018EEE")); }, [value]);
  const color = hsvToHex(...hsv);
  return <div className="field accent-picker">
    <span className="field-label">强调色</span>
    <div className="accent-presets">
      <button className="btn small" aria-pressed={!value} onClick={() => onChange(null)}>默认橙色</button>
      {presets.map(([name, hex]) => <button key={hex} className="accent-swatch" aria-label={`${name}色`} aria-pressed={value?.toLowerCase() === hex!.toLowerCase()}
        style={{ background: hex }} onClick={() => onChange(hex!)} />)}
    </div>
    <details><summary>自定义 HSV 颜色</summary>
      <div className="hsv-square" aria-label="饱和度与明度调色板" style={{ backgroundColor: `hsl(${hsv[0]} 100% 50%)` }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const r = event.currentTarget.getBoundingClientRect(); setHsv([hsv[0], Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100)), Math.max(0, Math.min(100, 100 - (event.clientY - r.top) / r.height * 100))]); }}
        onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const r = event.currentTarget.getBoundingClientRect(); setHsv([latest.current[0], Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100)), Math.max(0, Math.min(100, 100 - (event.clientY - r.top) / r.height * 100))]); }}>
        <span style={{ left: `${hsv[1]}%`, top: `${100 - hsv[2]}%` }} />
      </div>
      {(["色相", "饱和度", "明度"] as const).map((label, index) => <label className="hsv-channel" key={label}>{label}
        <input type="range" min="0" max={index === 0 ? 359 : 100} value={hsv[index]} onChange={(event) => setHsv(hsv.map((v, i) => i === index ? Number(event.target.value) : v) as typeof hsv)} />
      </label>)}
      <div className="row"><span className="accent-swatch" style={{ background: color }} /><code>{color.toUpperCase()}</code>
        <button className="btn small" onClick={() => onChange(color)}>应用颜色</button></div>
    </details>
  </div>;
}
