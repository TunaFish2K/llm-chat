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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) setDraft(value);
  }, [open, value]);

  const close = () => {
    if (draft !== value && !window.confirm("放弃尚未应用的编辑内容？")) return;
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
        aria-label={`展开编辑${label}`}
      >
        <span className={value ? "" : "muted"}>{value || placeholder || "点击展开编辑"}</span>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
      {open ? (
        <Modal
          title={label}
          onClose={close}
          fullscreen
          footer={
            <>
              <span className="small muted fullscreen-editor-hint">Ctrl/⌘ + Enter 应用</span>
              <button className="btn" onClick={close}>取消</button>
              <button className="btn primary" onClick={apply}>应用</button>
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
