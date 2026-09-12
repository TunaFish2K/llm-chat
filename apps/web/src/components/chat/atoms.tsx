import { t, useLocale, localized } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { offlineStore } from "../../lib/offline-history";
import { useStore } from "../../lib/store";
/** Small shared pieces of the conversation surface. */
import type { ReactNode } from "react";
import { Download, FileText } from "lucide-react";
import type { AgentSummaryDto, FileAssetDto, ImageAssetDto } from "@llm-chat/contracts";
import { toast } from "../../lib/app-state";
import { formatBytes } from "../../lib/format";

export function AgentAvatar({
  agent,
  label = "AI",
  size
}: {
  agent?: AgentSummaryDto | undefined;
  label?: string;
  size?: "large";
}) {
  useLocale();
  const className = size === "large" ? "agent-avatar large" : "agent-avatar";
  if (agent?.hasAvatar) {
    return (
      <span className={className}>
        <img src={`/api/agents/${agent.id}/avatar?t=${agent.updatedAt}`} alt="" />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {(agent?.name ?? label).slice(0, 1)}
    </span>
  );
}

export function OfflineAwareImage({ src, alt, ...props }: React.ComponentProps<"img">) {
  useLocale();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const offline = useStore(offlineStore, (state) => state.offline);
  if (failed && offline) return <span className="image-unavailable">{t("atoms.not_downloaded_connect_to_view_it", { value1: (alt || t("ModelPicker.images")) })}</span>;
  return <img {...props} src={src} alt={alt} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />;
}

/** Images always open through the server-issued URL, never a data: blob. */
export function ImageGallery({ assets }: { assets: ImageAssetDto[] }) {
  useLocale();
  return (
    <div className="message-images">
      {assets.map((asset) => (
        <a
          key={asset.id}
          href={asset.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${asset.fileName} · ${formatBytes(asset.byteSize)}`}
        >
          <OfflineAwareImage src={asset.url} alt={asset.fileName} loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  );
}

export function AssetGallery({ assets }: { assets: FileAssetDto[] }) {
  useLocale();
  const offline = useStore(offlineStore, (state) => state.offline);
  const images = assets.filter((asset): asset is ImageAssetDto => asset.kind === "image");
  const files = assets.filter((asset) => asset.kind === "file");
  return (
    <>
      {images.length ? <ImageGallery assets={images} /> : null}
      {files.length ? (
        <div className="message-files">
          {files.map((asset) => (
            <a key={asset.id} className="message-file" href={offline ? undefined : asset.url} aria-disabled={offline} download={asset.fileName}>
              <FileText size={18} aria-hidden="true" />
              <span><strong>{asset.fileName}</strong><small>{offline ? t("atoms.connect_to_download") : ""}{formatBytes(asset.byteSize)}</small></span>
              <Download size={16} aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** A hover-revealed icon action attached to a message or generation. */
export function MessageAction({
  label,
  onClick,
  danger,
  disabled,
  children
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  useLocale();
  return (
    <button
      type="button"
      className={danger ? "act danger" : "act"}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function CodeField({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  useLocale();
  return (
    <section className="tool-code-field">
      <strong>{label}</strong>
      <pre data-danger={danger || undefined}>{value}</pre>
    </section>
  );
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
  toast("success", localized("atoms.copied"));
}
