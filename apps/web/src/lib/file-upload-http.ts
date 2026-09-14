import type { FileUploadDto, FileUploadInput } from "@llm-chat/contracts";
import { errorI18n } from "@llm-chat/i18n";
import { ApiRequestError, httpRequest } from "./http-client";
import { t } from "./i18n";

async function request(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<FileUploadDto> {
  return (await httpRequest<FileUploadDto>(method, path, body, signal)).data;
}
export const fileUploadHttp = {
  create: (input: FileUploadInput, signal: AbortSignal) => request("POST", "/api/file-uploads", signal, input),
  get: (id: string, signal: AbortSignal) => request("GET", `/api/file-uploads/${id}`, signal),
  complete: (id: string, signal: AbortSignal) => request("POST", `/api/file-uploads/${id}/complete`, signal),
  cancel: async (id: string, signal: AbortSignal): Promise<void> => { await request("DELETE", `/api/file-uploads/${id}`, signal); },
  async append(id: string, offset: number, bytes: Blob, signal: AbortSignal): Promise<FileUploadDto> {
    let response: Response;
    try {
      response = await fetch(`/api/file-uploads/${id}?offset=${offset}`, {
        method: "PATCH", credentials: "same-origin", signal,
        headers: { "content-type": "application/octet-stream", "x-llm-chat-request": "1" }, body: bytes
      });
    } catch (error) {
      throw new ApiRequestError(0, "network_error", error instanceof Error ? error.message : t("uploads.network_error"));
    }
    if (response.status === 401) window.dispatchEvent(new Event("llm-chat:offline-auth-required"));
    const text = await response.text();
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ApiRequestError(response.status, "invalid_response", t("http_client.the_server_returned_a_response_that_could_not_be_parsed")); }
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiRequestError(response.status, error?.code ?? "upload_failed", error?.message ?? t("http_client.file_upload_failed"), undefined, errorI18n(error));
    }
    return value as FileUploadDto;
  }
};
export type FileUploadHttp = typeof fileUploadHttp;
