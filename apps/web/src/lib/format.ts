import { t, getLocale } from "./i18n";
export function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).format(timestamp);
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatCachedTokens(cached: number | undefined, input: number | undefined): string {
  const value = `${formatTokens(cached)} tokens`;
  if (cached === undefined || input === undefined || input <= 0) return value;
  const percentage = Math.max(0, Math.min(100, (cached / input) * 100));
  const digits = percentage > 0 && percentage < 1 ? 1 : 0;
  return getLocale() === "zh-CN" ? `${value}（${percentage.toFixed(digits)}%）` : `${value} (${percentage.toFixed(digits)}%)`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("format.could_not_read_the_file")));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
