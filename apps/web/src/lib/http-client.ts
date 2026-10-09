import { errorI18n, type LocalizedMessage } from "@llm-chat/i18n";
import { displayError } from "./error-display";
import { t } from "./i18n";
import type { FileAssetDto } from "@llm-chat/contracts";
import { requestRetries } from "./request-preferences";
import { retryRequest } from "./request-retry";
import { acceptServerId, apiBase, apiCredentials, apiUrl, ensureChannelReady, SERVER_ID_HEADER } from "./server-channel";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly i18n?: LocalizedMessage,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ApiRequestError";
    const raw = message;
    Object.defineProperty(this, "message", { configurable: true, get: () => displayError({ message: raw, ...(i18n ? { i18n } : {}) }) });
  }
}

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

export function onAuthRequired(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function emitAuthRequired(): void {
  for (const listener of authListeners) listener();
}

function channelMismatch(): ApiRequestError {
  const i18n = { key: "http_client.server_channel_mismatch" } as const;
  return new ApiRequestError(409, "server_channel_mismatch", t(i18n.key), undefined, i18n);
}

/**
 * Sends an API request through the active server channel. Responses from a
 * channel that reports another server identity never reach the caller.
 */
export function channelFetch(path: string, init: RequestInit): Promise<Response> {
  const send = () => fetch(apiUrl(path), { ...init, credentials: apiCredentials() }).then((response) => {
    if (!acceptServerId(response.headers.get(SERVER_ID_HEADER))) throw channelMismatch();
    return response;
  });
  // The page origin needs no identity check; send in the same tick as before.
  if (!apiBase()) return send();
  return ensureChannelReady().then((matches) => {
    if (!matches) throw channelMismatch();
    return send();
  });
}

export interface HttpResult<T> { data: T; status: number }

/**
 * Browsers hide why a fetch failed, so tell offline devices apart from a server
 * that cannot be reached and name the server in the message.
 */
export function networkFailure(): ApiRequestError {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new ApiRequestError(0, "network_offline", t("http_client.offline"), undefined, { key: "http_client.offline" });
  }
  let host = "";
  try { host = new URL(apiUrl("/"), typeof location === "undefined" ? "http://localhost" : location.href).host; } catch { /* keep generic */ }
  if (!host) return new ApiRequestError(0, "network_error", t("http_client.network_request_failed"), undefined, { key: "http_client.network_request_failed" });
  const i18n = { key: "http_client.server_unreachable", params: { host } } as const;
  return new ApiRequestError(0, "network_error", t(i18n.key, i18n.params), undefined, i18n);
}

/** A deadline covers both response headers and the response body. */
export function withRequestSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiRequestError(0, signal.reason?.name === "TimeoutError" ? "request_timeout" : "request_cancelled",
      t(signal.reason?.name === "TimeoutError" ? "http_client.request_timeout" : "http_client.network_request_failed")));
    if (signal.aborted) { void operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
let requestSession = new AbortController();
export function resetRequestSession(): void {
  requestSession.abort();
  requestSession = new AbortController();
}
export function requestBudget(method: string, retries = requestRetries()): number {
  return (method === "GET" ? 15_000 : 30_000) * (retries + 1) + retries * 10_000 + 1_000;
}
export function httpRequest<T>(method: string, path: string, body: unknown, signal: AbortSignal, options: { retries?: number; requestId?: string } = {}): Promise<HttpResult<T>> {
  const maxRetries = options.retries ?? requestRetries();
  const deadline = AbortSignal.any([signal, requestSession.signal, AbortSignal.timeout(requestBudget(method, maxRetries))]);
  const requestId = method === "GET" || method === "HEAD" ? undefined : options.requestId ?? crypto.randomUUID();
  const serialized = body !== undefined ? JSON.stringify(body) : null;
  const action = () => {
    const attempt = AbortSignal.any([deadline, AbortSignal.timeout(method === "GET" ? 15_000 : 30_000)]);
    return withRequestSignal(performHttpRequest<T>(method, path, serialized, attempt, requestId), attempt).catch(error => {
      if (error instanceof ApiRequestError) throw error;
      throw networkFailure();
    });
  };
  return withRequestSignal(retryRequest(action, deadline, maxRetries), deadline).catch(error => {
    if (error instanceof ApiRequestError) throw error;
    throw networkFailure();
  });
}

async function performHttpRequest<T>(method: string, path: string, body: string | null, signal: AbortSignal, requestId?: string): Promise<HttpResult<T>> {
  let response: Response;
  try {
    response = await channelFetch(path, {
      method,
      signal,
      headers: {
        ...(body !== null ? { "content-type": "application/json" } : {}),
        ...(requestId ? { "x-llm-chat-request": "1", "x-llm-chat-request-id": requestId } : {})
      },
      body
    });
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw networkFailure();
  }
  if (response.status === 401) {
    const text = await response.text();
    let serverMessage = t("http_client.enter_the_access_password");
    let serverCode = "authentication_required";
    let descriptor: LocalizedMessage | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      descriptor = errorI18n(parsed.error);
      serverCode = parsed.error?.code ?? serverCode;
      serverMessage = parsed.error?.message ?? serverMessage;
    } catch {
      /* keep defaults */
    }
    // Only a missing/expired session invalidates global auth state. Other 401s
    // (e.g. a wrong password on the login form) stay local to the caller.
    if (serverCode === "authentication_required") emitAuthRequired();
    throw new ApiRequestError(401, serverCode, serverMessage, undefined, descriptor);
  }
  if (response.status === 204) {
    return { data: undefined as T, status: response.status };
  }
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiRequestError(response.status, "invalid_response", t("http_client.the_server_returned_a_response_that_could_not_be_parsed"));
    }
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? "request_failed",
      error?.message ?? t("http_client.request_failed_http", { value1: (response.status) }),
      error?.details,
      errorI18n(error),
      retryAfter(response.headers.get("retry-after"))
    );
  }
  return { data: data as T, status: response.status };
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function uploadFileHttp(file: File, signal = new AbortController().signal): Promise<FileAssetDto> {
  const maxRetries = requestRetries();
  const deadline = AbortSignal.any([signal, requestSession.signal, AbortSignal.timeout(requestBudget("POST", maxRetries))]);
  const requestId = crypto.randomUUID();
  return withRequestSignal(retryRequest(() => {
    const attempt = AbortSignal.any([deadline, AbortSignal.timeout(30_000)]);
    return withRequestSignal(performFileUpload(file, requestId, attempt), attempt).catch(error => {
      if (error instanceof ApiRequestError) throw error;
      throw new ApiRequestError(0, "network_error", t("http_client.network_request_failed"));
    });
  }, deadline, maxRetries), deadline);
}

async function performFileUpload(file: File, requestId: string, signal: AbortSignal): Promise<FileAssetDto> {
  const response = await channelFetch("/api/files", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/octet-stream",
      "x-llm-chat-request": "1",
      "x-llm-chat-request-id": requestId,
      "x-file-name": encodeURIComponent(file.name || "file"),
      "x-file-type": file.type || "application/octet-stream"
    },
    body: file
  });
  if (response.status === 401) emitAuthRequired();
  const data = await response.json() as FileAssetDto | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiRequestError(response.status, error?.code ?? "upload_failed", error?.message ?? t("http_client.file_upload_failed"), undefined, errorI18n(error), retryAfter(response.headers.get("retry-after")));
  }
  return data as FileAssetDto;
}
