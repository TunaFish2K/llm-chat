import { withMessage, type MessageKey } from "@llm-chat/i18n";
import { ProviderError } from "./types";

interface NetworkFailure {
  code: string;
  key: MessageKey;
  message: (host: string, detail: string) => string;
  status: number;
}

const DNS: NetworkFailure = { code: "network_dns_error", key: "error.network_dns_error", status: 502,
  message: (host) => `无法解析域名 ${host}，请检查 Base URL 拼写或 DNS 设置` };
const REFUSED: NetworkFailure = { code: "network_connection_refused", key: "error.network_connection_refused", status: 502,
  message: (host) => `${host} 拒绝连接，请检查端口是否正确、服务是否正在运行` };
const CONNECT_TIMEOUT: NetworkFailure = { code: "network_connect_timeout", key: "error.network_connect_timeout", status: 504,
  message: (host) => `连接 ${host} 超时，请检查网络或代理（Node 默认不读取 HTTP(S)_PROXY，需要设置 NODE_USE_ENV_PROXY=1）` };
const RESET: NetworkFailure = { code: "network_connection_reset", key: "error.network_connection_reset", status: 502,
  message: (host) => `与 ${host} 的连接被中断，常见原因是请求体过大、代理断开或上游服务重启` };
const RESPONSE_TIMEOUT: NetworkFailure = { code: "network_response_timeout", key: "error.network_response_timeout", status: 504,
  message: (host) => `${host} 长时间没有返回响应` };
const STREAM_TIMEOUT: NetworkFailure = { code: "network_stream_timeout", key: "error.network_stream_timeout", status: 504,
  message: (host) => `${host} 的流式输出长时间没有新数据` };
const TLS: NetworkFailure = { code: "network_tls_error", key: "error.network_tls_error", status: 502,
  message: (host, detail) => `与 ${host} 建立 TLS 连接失败（${detail}），请检查证书或 Base URL 的协议` };
const UNREACHABLE: NetworkFailure = { code: "network_unreachable", key: "error.network_unreachable", status: 502,
  message: (host) => `网络不可达，无法访问 ${host}` };
const TOO_LARGE: NetworkFailure = { code: "request_too_large", key: "error.request_too_large", status: 413,
  message: () => "请求体过大，请减少图片或附件后重试" };
const TIMEOUT: NetworkFailure = { code: "network_timeout", key: "error.network_timeout", status: 504,
  message: (host) => `请求 ${host} 超时` };
const GENERIC: NetworkFailure = { code: "network_error", key: "error.network_error", status: 502,
  message: (host, detail) => `请求 ${host} 失败：${detail}` };

const CODES: Record<string, NetworkFailure> = {
  ENOTFOUND: DNS, EAI_AGAIN: DNS, EAI_NONAME: DNS, EAI_FAIL: DNS,
  ECONNREFUSED: REFUSED,
  ETIMEDOUT: CONNECT_TIMEOUT, UND_ERR_CONNECT_TIMEOUT: CONNECT_TIMEOUT,
  ECONNRESET: RESET, EPIPE: RESET, ECONNABORTED: RESET, UND_ERR_SOCKET: RESET, UND_ERR_CLOSED: RESET,
  UND_ERR_HEADERS_TIMEOUT: RESPONSE_TIMEOUT,
  UND_ERR_BODY_TIMEOUT: STREAM_TIMEOUT,
  ENETUNREACH: UNREACHABLE, EHOSTUNREACH: UNREACHABLE, ENETDOWN: UNREACHABLE, EHOSTDOWN: UNREACHABLE,
  UND_ERR_REQ_CONTENT_LENGTH_MISMATCH: TOO_LARGE
};

function classify(code: string): NetworkFailure | undefined {
  if (CODES[code]) return CODES[code];
  if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)|SELF_SIGNED|^EPROTO$/.test(code)) return TLS;
  return undefined;
}

function hostOf(url: string | URL | undefined): string {
  if (!url) return "上游服务";
  try { return new URL(url).host || String(url); } catch { return String(url); }
}

/**
 * Node's fetch reports every transport failure as `TypeError: fetch failed` and
 * keeps the real reason in `cause`. Turn that chain into an actionable message.
 */
export function describeNetworkError(error: unknown, url?: string | URL): ProviderError | null {
  if (error instanceof ProviderError) return null;
  if (error instanceof DOMException && error.name === "AbortError") return null;
  const host = hostOf(url);
  const build = (failure: NetworkFailure, detail: string) => {
    const wrapped = new ProviderError(failure.code, failure.message(host, detail), failure.status);
    return withMessage(wrapped, failure.key, { host, detail });
  };
  if (error instanceof DOMException && error.name === "TimeoutError") return build(TIMEOUT, error.message);
  if (error instanceof RangeError && /invalid string length|array buffer allocation/i.test(error.message)) return build(TOO_LARGE, error.message);
  let current: unknown = error;
  let fetchFailure = false;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const item = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    const code = typeof item.code === "string" ? item.code : "";
    const failure = code ? classify(code) : undefined;
    if (failure) return build(failure, code);
    if (item.name === "TimeoutError") return build(TIMEOUT, String(item.message ?? ""));
    if (item instanceof TypeError && (item.message === "fetch failed" || item.message === "terminated")) fetchFailure = true;
    if (typeof item.message === "string" && /other side closed|socket hang up/i.test(item.message)) return build(RESET, item.message);
    current = item.cause;
  }
  if (!fetchFailure) return null;
  const root = innermost(error);
  return build(GENERIC, root);
}

function innermost(error: unknown): string {
  let current: unknown = error;
  let detail = "";
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const item = current as { code?: unknown; message?: unknown; cause?: unknown };
    const text = [typeof item.code === "string" ? item.code : "", typeof item.message === "string" ? item.message : ""].filter(Boolean).join(" ");
    if (text) detail = text;
    current = item.cause;
  }
  return detail || "fetch failed";
}

/** `fetch` that rethrows transport failures as classified ProviderErrors. */
export async function providerFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw describeNetworkError(error, url) ?? error;
  }
}
