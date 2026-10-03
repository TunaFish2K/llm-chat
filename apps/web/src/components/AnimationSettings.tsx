import { useLayoutEffect } from "react";
import { ANIMATION_CATEGORIES, ANIMATION_DEFAULTS, animationMilliseconds, animationStore, initializeAnimationPreferences, saveAnimationPreferences } from "../lib/animation-preferences";
import { t, useLocale } from "../lib/i18n";
import { useStore } from "../lib/store";

export function AnimationSettings() {
  useLocale();
  const speeds = useStore(animationStore, state => state.values);
  const saved = useStore(animationStore, state => state.saved);
  useLayoutEffect(initializeAnimationPreferences, []);
  return <div className="settings-panels"><div className="card">
    <h3>{t("AnimationSettings.title")}</h3>
    <div className="animation-controls">
      {ANIMATION_CATEGORIES.map(category => {
        const speed = speeds[category], label = t(`AnimationSettings.${category}`);
        const value = speed === 0 ? t("AnimationSettings.off") : category === "loading" ? `${speed}×` : `${speed}× · ${Math.round(animationMilliseconds(category, "enter", speed))} ms`;
        return <label className="animation-control" key={category}>
          <span>{label}<output>{value}</output></span>
          <input type="range" aria-label={label} aria-valuetext={value} min={0} max={3} step={.25} value={speed}
            onChange={event => saveAnimationPreferences({ [category]: Number(event.target.value) })} />
        </label>;
      })}
    </div>
    <div className="row">
      <button type="button" className="btn small" onClick={() => saveAnimationPreferences(ANIMATION_DEFAULTS)}>{t("ChatTypographySettings.restore_defaults")}</button>
      {!saved ? <span role="alert">{t("AnimationSettings.not_saved")}
        <button type="button" className="btn small" onClick={() => saveAnimationPreferences()}>{t("NotificationSettings.retry")}</button>
      </span> : null}
    </div>
  </div></div>;
}
