import { apiCredentials, assetUrl } from "./server-channel";

export interface AssetSource {
  url: string;
  fileName: string;
  /** Known before fetching for stored assets; images from markdown only learn it from the response. */
  mimeType?: string | undefined;
}

export type ShareOutcome = "shared" | "cancelled" | "retry";

// The last fetched file, so a share retried after the browser expired the tap does not fetch again.
let lastFile: { url: string; file: File } | undefined;

/** Fetches an asset as a named file, bypassing the HTTP cache. */
export async function fetchAssetFile(asset: AssetSource): Promise<File> {
  const url = assetUrl(asset.url) ?? asset.url;
  if (lastFile?.url === url) return lastFile.file;
  // Older servers cached <img> loads without `Vary: Origin`; reusing that copy fails CORS for another channel.
  const response = await fetch(url, { credentials: apiCredentials(), cache: "reload" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  // Attachments are served as octet-stream so browsers never render them; the stored type names what they are.
  const type = asset.mimeType && (!blob.type || blob.type === "application/octet-stream") ? asset.mimeType : blob.type;
  const file = new File([blob], withExtension(asset.fileName || "image", type), { type });
  lastFile = { url, file };
  return file;
}

/** Saves an asset as a file; a plain download link would only open it when the API is on another origin. */
export async function downloadAsset(asset: AssetSource): Promise<void> {
  const file = await fetchAssetFile(asset);
  const objectUrl = URL.createObjectURL(file);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

/** Whether the system share sheet accepts a file of this type, which is how a web app opens it in another app. */
export function canShareFile(fileName: string, mimeType: string): boolean {
  try {
    return typeof navigator.share === "function"
      && navigator.canShare?.({ files: [new File([], fileName || "file", { type: mimeType })] }) === true;
  } catch {
    return false;
  }
}

/**
 * Hands an asset to another app through the share sheet. A slow fetch can
 * outlast the tap that allowed sharing; the file is then kept for a retry.
 */
export async function shareAsset(asset: AssetSource): Promise<ShareOutcome> {
  const cached = lastFile?.url === (assetUrl(asset.url) ?? asset.url);
  const file = await fetchAssetFile(asset);
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    // Without a fetch in between the tap was still fresh, so the browser refuses sharing itself.
    if (error instanceof DOMException && error.name === "NotAllowedError" && !cached) return "retry";
    throw error;
  }
}

/** Markdown images are named after their alt text, which rarely carries an extension. */
function withExtension(name: string, mimeType: string): string {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" }[mimeType];
  return !extension || /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extension}`;
}
