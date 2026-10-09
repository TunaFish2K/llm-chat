import { useRef, useState, type ChangeEvent } from "react";

/**
 * Temporary diagnostics for the delayed Android file picker. Each row records how long the
 * system picker takes to cover the page after a tap. Remove once the cause is settled.
 */
const VARIANTS = [
  { key: "A", text: "无 accept", accept: undefined, multiple: false },
  { key: "B", text: "accept=image/*", accept: "image/*", multiple: false },
  { key: "C", text: "accept=jpeg,png,webp,gif", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: false },
  { key: "D", text: "C + multiple", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: true },
  { key: "E", text: "无 accept + multiple", accept: undefined, multiple: true }
] as const;

type Activation = "label" | "script";

export function PickerProbe() {
  const [log, setLog] = useState<string[]>([]);
  const pending = useRef<{ name: string; at: number } | null>(null);
  const write = (line: string) => setLog((lines) => [`${new Date().toLocaleTimeString()} ${line}`, ...lines].slice(0, 60));

  const start = (name: string) => {
    pending.current = { name, at: performance.now() };
    const hidden = () => {
      const current = pending.current;
      if (!current || document.visibilityState !== "hidden") return;
      write(`${current.name}：选择器出现 ${Math.round(performance.now() - current.at)} ms`);
      pending.current = null;
    };
    document.addEventListener("visibilitychange", hidden, { once: true });
    window.addEventListener("blur", () => {
      const current = pending.current;
      if (current) write(`${current.name}：页面失焦 ${Math.round(performance.now() - current.at)} ms`);
    }, { once: true });
  };
  const done = (name: string) => (event: ChangeEvent<HTMLInputElement>) => {
    write(`${name}：返回 ${event.currentTarget.files?.length ?? 0} 个文件`);
    event.currentTarget.value = "";
  };

  return <div className="picker-probe">
    <h3>文件选择器诊断</h3>
    <p className="muted">冷启动应用后，每一行点一次，返回后记录耗时。</p>
    {VARIANTS.map((variant) => (["label", "script"] as Activation[]).map((activation) => {
      const name = `${variant.key}-${activation === "label" ? "label" : "click()"}`;
      const id = `picker-probe-${name}`;
      return <div className="picker-probe-row" key={name}>
        <input id={id} className="sr-only" type="file" tabIndex={-1} accept={variant.accept} multiple={variant.multiple}
          onChange={done(name)} />
        {activation === "label"
          ? <label htmlFor={id} className="btn secondary" onClick={() => start(name)}>{name}：{variant.text}</label>
          : <button type="button" className="btn secondary" onClick={() => { start(name); (document.getElementById(id) as HTMLInputElement).click(); }}>{name}：{variant.text}</button>}
      </div>;
    }))}
    <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(log.join("\n"))}>复制记录</button>
    <pre className="picker-probe-log">{log.join("\n")}</pre>
  </div>;
}
