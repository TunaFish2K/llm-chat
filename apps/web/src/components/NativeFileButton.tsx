import type { ChangeEvent, ReactNode } from "react";

export function NativeFileButton({
  label,
  children,
  accept,
  multiple = false,
  disabled = false,
  busy = false,
  className = "",
  onFiles
}: {
  label: string;
  children: ReactNode;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  onFiles: (files: File[]) => void | Promise<void>;
}) {
  const changed = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length) void onFiles(files);
  };

  return (
    <label
      className={`native-file-button ${className}`.trim()}
      data-disabled={disabled || busy || undefined}
      title={label}
      aria-busy={busy || undefined}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled || busy}
        aria-label={label}
        onChange={changed}
      />
      <span aria-hidden="true">{children}</span>
    </label>
  );
}
