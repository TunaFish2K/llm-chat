import { useEffect } from "react";
import { appStore } from "../lib/app-state";
import { CHAT_TYPOGRAPHY_DEFAULTS, initializeTypography, saveTypography, typographyStore } from "../lib/local-typography";
export { CHAT_TYPOGRAPHY_DEFAULTS } from "../lib/local-typography";
import { useStore } from "../lib/store";
import { Markdown } from "../lib/markdown";

const controls = [
  { key: "chatFontSize", label: "字号", min: 12, max: 24, step: 0.5, unit: "px" },
  { key: "chatLetterSpacing", label: "字间距", min: 0, max: 0.15, step: 0.01, unit: "em" },
  { key: "chatLineHeight", label: "行间距", min: 1.2, max: 2.4, step: 0.05, unit: "倍" }
] as const;

export function ChatTypographySettings({ preview = false }: { preview?: boolean }) {
  const settings = useStore(appStore, (state) => state.settings);
  const preferences = useStore(typographyStore, (state) => state.values);
  const saved = useStore(typographyStore, (state) => state.saved);
  useEffect(() => initializeTypography(settings?.uiPreferences), [settings]);
  return <div className={`chat-typography-settings${preview ? " with-preview" : ""}`}>
    <div className="chat-typography-controls">
      {controls.map(({ key, label, min, max, step, unit }) => {
        const value = preferences?.[key] ?? CHAT_TYPOGRAPHY_DEFAULTS[key];
        return <label className="chat-typography-control" key={key}>
          <span>{label}<output>{value} {unit}</output></span>
          <input type="range" aria-label={label} aria-valuetext={`${value} ${unit}`} min={min} max={max} step={step} value={value}
            onChange={(event) => saveTypography({ [key]: Number(event.target.value) })}
 />
        </label>;
      })}
      <div className="chat-typography-save">
        <button type="button" className="btn small" onClick={() => saveTypography(CHAT_TYPOGRAPHY_DEFAULTS)}>恢复默认</button>
        {!saved ? <span role="alert">未保存 <button type="button" className="btn small" onClick={() => saveTypography()}>重试</button></span>
          : <span role="status">已保存到此浏览器</span>}
      </div>
    </div>
    {preview ? <div className="chat-typography-preview" aria-label="聊天排版预览">
      <div className="chat-thread">
        <div className="msg" data-role="user"><div className="msg-bubble">你好，看看这样的排版是否舒服？</div></div>
        <div className="msg" data-role="assistant">
          <div className="process-reasoning"><div>推理过程：让文字清晰，也保留适当的留白。</div></div>
          <Markdown text={'这是一段聊天预览。Hello, make yourself comfortable.\n\n- 支持 **Markdown** 与中英文混排\n\n```js\nconst message = "你好";\n```'} />
        </div>
      </div>
      <textarea className="composer-input" aria-label="输入文字预览" readOnly tabIndex={-1} rows={1} value="输入消息，实时查看效果…" />
    </div> : null}
  </div>;
}
