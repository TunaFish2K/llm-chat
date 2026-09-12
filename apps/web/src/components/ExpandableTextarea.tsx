import { t, useLocale } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Modal } from "../lib/ui";

export function ExpandableTextarea({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  disabled = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  const close = () => {
    if (draft !== value && !window.confirm(t("ExpandableTextarea.discard_edits_that_have_not_been_applied"))) return;
    setOpen(false);
  };
  const apply = () => {
    onChange(draft);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className={`expandable-textarea-preview${mono ? " mono" : ""}`}
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
        disabled={disabled}
        aria-label={t("ExpandableTextarea.expand_editor", { value1: (label) })}
      >
        <span className={value ? "" : "muted"}>{value || placeholder || t("ExpandableTextarea.click_to_expand_editor")}</span>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
      {open ? (
        <Modal
          title={label}
          onClose={close}
          fullscreen
          footer={
            <>
              <span className="small muted fullscreen-editor-hint">{t("ExpandableTextarea.ctrl_enter_to_apply")}</span>
              <button className="btn" onClick={close}>{t("WorkspaceSidebar.cancel")}</button>
              <button className="btn primary" onClick={apply}>{t("ExpandableTextarea.apply")}</button>
            </>
          }
        >
          <textarea
            ref={editor}
            className={`textarea fullscreen-textarea${mono ? " mono" : ""}`}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                apply();
              }
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}
