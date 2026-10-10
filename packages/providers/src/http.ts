import { withMessage } from "@llm-chat/i18n";
import { httpHeaderNameSchema, httpHeaderValueSchema } from "@llm-chat/contracts";
import { ProviderError, type ProviderConnection, type ProviderRequestContext } from "./types";
import { describeNetworkError, providerFetch } from "./network-error";

export function endpoint(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  const cleanResource = resource.replace(/^\/+/, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/${cleanResource}`)) return url.toString().replace(/\/$/, "");
  url.pathname = `${path || "/v1"}/${cleanResource}`.replace(/\/+/g, "/");
  return url.toString();
}

export function headers(
  connection: ProviderConnection,
  requestContext?: ProviderRequestContext
): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" };
  if (connection.apiKey) {
    if (!httpHeaderValueSchema.safeParse(connection.apiKey).success) {
      throw withMessage(new ProviderError("provider_config_error", "API Key 含有无效字符。请重新填写服务商提供的密钥，不要粘贴说明文字或换行。", 400), "error.invalid_connection_api_key");
    }
    if (connection.protocol === "anthropic-messages") {
      result["x-api-key"] = connection.apiKey;
      result["anthropic-version"] = "2023-06-01";
    } else {
      result.authorization = `Bearer ${connection.apiKey}`;
    }
  }
  let merged = { ...result, ...connection.secretHeaders };
  if (connection.providerId === "opencode-go" && requestContext) {
    merged = {
      ...merged,
      "x-opencode-session": requestContext.sessionId,
      "x-opencode-request": requestContext.requestId,
      "x-opencode-client": requestContext.clientId,
      "User-Agent": requestContext.userAgent
    };
  }
  if (Object.entries(merged).some(([name, value]) => !httpHeaderNameSchema.safeParse(name).success || !httpHeaderValueSchema.safeParse(value).success)) {
    throw withMessage(new ProviderError("provider_config_error", "请求头格式无效。请检查请求头名称，移除值中的中文、换行或其他控制字符。", 400), "error.invalid_connection_headers");
  }
  return merged;
}

/** The human-readable part of an upstream error body, or "" when it carries none (HTML pages are never shown). */
export function providerErrorMessage(text: string): string {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return ""; }
  if (!body || typeof body !== "object") return "";
  const { error, message, errors } = body as { error?: unknown; message?: unknown; errors?: unknown };
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  if (typeof message === "string") return message;
  if (Array.isArray(errors)) return errors.filter((item): item is string => typeof item === "string").join("; ");
  return "";
}

export async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  const message = providerErrorMessage(await response.text().catch(() => ""));
  const suffix = requestId ? `（request id: ${requestId}）` : "";
  const code = response.status === 401 || response.status === 403
    ? "provider_auth_error"
    : response.status === 429
      ? "provider_rate_limit"
      : "provider_http_error";
  if (message) throw new ProviderError(code, message + suffix, response.status);
  throw withMessage(new ProviderError(code, `上游服务返回 HTTP ${response.status}${suffix}`, response.status), "error.upstream_http_status", { status: response.status, suffix });
}

export async function* readSse(response: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw withMessage(new ProviderError("provider_stream_error", "上游服务没有返回响应流"), "error.the_upstream_service_did_not_return_a_response_stream");
  const reader = response.body.getReader();
  // A streaming decoder keeps partial UTF-8 sequences, so it must not be shared
  // between concurrent responses.
  const textDecoder = new TextDecoder();
  let buffer = "";
  // Resume the boundary search where the last one stopped so a multi-megabyte
  // frame, such as a generated image, is not rescanned on every chunk.
  let scanned = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += textDecoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n", scanned);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
        boundary = buffer.indexOf("\n\n");
      }
      scanned = Math.max(0, buffer.length - 1);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof ProviderError) throw error;
    throw describeNetworkError(error, response.url || undefined) ?? new ProviderError(
      "provider_stream_error",
      error instanceof Error ? error.message : "读取上游响应流失败"
    );
  } finally {
    reader.releaseLock();
  }
}

export async function listModelEndpoint(
  connection: ProviderConnection,
  signal?: AbortSignal,
  requestContext?: ProviderRequestContext
): Promise<Array<{ id: string; displayName: string }>> {
  const response = await providerFetch(endpoint(connection.baseUrl, "models"), {
    headers: headers(connection, requestContext),
    ...(signal ? { signal } : {})
  });
  await ensureOk(response);
  const body = (await response.json()) as {
    data?: Array<{ id?: string; display_name?: string; displayName?: string }>;
    models?: Array<{ id?: string; name?: string; display_name?: string }>;
  };
  const items = body.data ?? body.models ?? [];
  return items
    .filter((item): item is typeof item & { id: string } => typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      displayName: item.display_name ?? ("displayName" in item ? item.displayName : undefined) ?? ("name" in item ? item.name : undefined) ?? item.id
    }));
}

/**
 * Reads a response body up to `limit` bytes. Returns null and cancels the body
 * as soon as the limit is exceeded, so a response without Content-Length cannot
 * be buffered without bound.
 */
export async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    throw describeNetworkError(error, response.url || undefined) ?? error;
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
