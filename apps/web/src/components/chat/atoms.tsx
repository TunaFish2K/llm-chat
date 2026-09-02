/** Small shared pieces of the conversation surface. */
import type { ReactNode } from "react";
import type { AgentSummaryDto, ImageAssetDto } from "@llm-chat/contracts";
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

/** Images always open through the server-issued URL, never a data: blob. */
export function ImageGallery({ assets }: { assets: ImageAssetDto[] }) {
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
          <img src={asset.url} alt={asset.fileName} loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
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
  return (
    <section className="tool-code-field">
      <strong>{label}</strong>
      <pre data-danger={danger || undefined}>{value}</pre>
    </section>
  );
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
  toast("success", "已复制");
}
