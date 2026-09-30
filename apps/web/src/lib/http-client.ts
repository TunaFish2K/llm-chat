import { errorI18n, type LocalizedMessage } from "@llm-chat/i18n";
import { displayError } from "./error-display";
import { t } from "./i18n";
import type { FileAssetDto } from "@llm-chat/contracts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly i18n?: LocalizedMessage
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

export interface HttpResult<T> { data: T; status: number }

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
export function httpRequest<T>(method: string, path: string, body: unknown, signal: AbortSignal): Promise<HttpResult<T>> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(method === "GET" ? 15_000 : 30_000)]);
  return withRequestSignal(performHttpRequest<T>(method, path, body, deadline), deadline).catch(error => {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(0, "network_error", t("http_client.network_request_failed"));
  });
}

async function performHttpRequest<T>(method: string, path: string, body: unknown, signal: AbortSignal): Promise<HttpResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" && method !== "HEAD" ? { "x-llm-chat-request": "1" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : null
    });
  } catch (error) {
    throw new ApiRequestError(0, "network_error", t("http_client.network_request_failed"), undefined, { key: "http_client.network_request_failed" });
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
      errorI18n(error)
    );
  }
  return { data: data as T, status: response.status };
}

export async function uploadFileHttp(file: File): Promise<FileAssetDto> {
  const response = await fetch("/api/files", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/octet-stream",
      "x-llm-chat-request": "1",
      "x-file-name": encodeURIComponent(file.name || "file"),
      "x-file-type": file.type || "application/octet-stream"
    },
    body: file
  });
  if (response.status === 401) emitAuthRequired();
  const data = await response.json() as FileAssetDto | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiRequestError(response.status, error?.code ?? "upload_failed", error?.message ?? t("http_client.file_upload_failed"), undefined, errorI18n(error));
  }
  return data as FileAssetDto;
}

