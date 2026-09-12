import { t, useLocale } from "../lib/i18n";
import { useEffect } from "react";
import { appStore } from "../lib/app-state";
import { CHAT_TYPOGRAPHY_DEFAULTS, initializeTypography, saveTypography, typographyStore } from "../lib/local-typography";
export { CHAT_TYPOGRAPHY_DEFAULTS } from "../lib/local-typography";
import { useStore } from "../lib/store";
import { Markdown } from "../lib/markdown";

function getcontrols() { return [
  { key: "chatFontSize", label: t("ChatTypographySettings.font_size"), min: 12, max: 24, step: 0.5, unit: "px" },
  { key: "chatLetterSpacing", label: t("ChatTypographySettings.letter_spacing"), min: 0, max: 0.15, step: 0.01, unit: "em" },
  { key: "chatLineHeight", label: t("ChatTypographySettings.line_height"), min: 1.2, max: 2.4, step: 0.05, unit: t("ChatTypographySettings.label") }
] as const; }

export function ChatTypographySettings({ preview = false }: { preview?: boolean }) {
  useLocale();
  const settings = useStore(appStore, (state) => state.settings);
  const preferences = useStore(typographyStore, (state) => state.values);
  const saved = useStore(typographyStore, (state) => state.saved);
  useEffect(() => initializeTypography(settings?.uiPreferences), [settings]);
  return <div className={`chat-typography-settings${preview ? " with-preview" : ""}`}>
    <div className="chat-typography-controls">
      {getcontrols().map(({ key, label, min, max, step, unit }) => {
        const value = preferences?.[key] ?? CHAT_TYPOGRAPHY_DEFAULTS[key];
        return <label className="chat-typography-control" key={key}>
          <span>{label}<output>{value} {unit}</output></span>
          <input type="range" aria-label={label} aria-valuetext={`${value} ${unit}`} min={min} max={max} step={step} value={value}
            onChange={(event) => saveTypography({ [key]: Number(event.target.value) })}
 />
        </label>;
      })}
      <div className="chat-typography-save">
        <button type="button" className="btn small" onClick={() => saveTypography(CHAT_TYPOGRAPHY_DEFAULTS)}>{t("ChatTypographySettings.restore_defaults")}</button>
        {!saved ? <span role="alert">{t("ChatTypographySettings.not_saved")}<button type="button" className="btn small" onClick={() => saveTypography()}>{t("NotificationSettings.retry")}</button></span>
          : <span role="status">{t("ChatTypographySettings.saved_in_this_browser")}</span>}
      </div>
    </div>
    {preview ? <div className="chat-typography-preview" aria-label={t("ChatTypographySettings.chat_typography_preview")}>
      <div className="chat-thread">
        <div className="msg" data-role="user"><div className="msg-bubble">{t("ChatTypographySettings.hello_does_this_text_feel_comfortable_to_read")}</div></div>
        <div className="msg" data-role="assistant">
          <div className="process-reasoning"><div>{t("ChatTypographySettings.reasoning_keep_text_clear_and_leave_enough_breathing_room")}</div></div>
          <Markdown text={t("ChatTypographySettings.this_is_a_chat_preview_n_n_supports_markdown_and")} />
        </div>
      </div>
      <textarea className="composer-input" aria-label={t("ChatTypographySettings.type_to_preview")} readOnly tabIndex={-1} rows={1} value={t("ChatTypographySettings.type_a_message_to_preview_changes")} />
    </div> : null}
  </div>;
}
