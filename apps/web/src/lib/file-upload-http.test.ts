import { describe, expect, it, vi } from "vitest";
import { fileUploadHttp } from "./file-upload-http";

describe("resumable upload HTTP", () => {
  it("uses JSON control requests and raw bounded chunks with cancellation and credentials", async () => {
    const value = { id: "id", offset: 3 };
    const fetch = vi.fn(async () => new Response(JSON.stringify(value), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(fileUploadHttp.create({ id: "id", fileName: "x", mimeType: "text/plain", byteSize: 3, sha256: "a".repeat(64) }, signal)).resolves.toEqual(value);
    await fileUploadHttp.get("id", signal); await fileUploadHttp.complete("id", signal);
    const blob = new Blob(["abc"]); await expect(fileUploadHttp.append("id", 0, blob, signal)).resolves.toEqual(value);
    expect(fetch).toHaveBeenLastCalledWith("/api/file-uploads/id?offset=0", expect.objectContaining({ method: "PATCH", body: blob, signal, credentials: "same-origin", headers: { "content-type": "application/octet-stream", "x-llm-chat-request": "1" } }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(fileUploadHttp.cancel("id", signal)).resolves.toBeUndefined();
  });
  it("maps network, authentication, proxy, and application failures", async () => {
    const append = () => fileUploadHttp.append("id", 0, new Blob(["x"]), new AbortController().signal);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fetch.mockRejectedValueOnce(new TypeError("disconnected")); await expect(append()).rejects.toMatchObject({ status: 0, code: "network_error" });
    fetch.mockRejectedValueOnce("offline"); await expect(append()).rejects.toMatchObject({ status: 0 });
    const auth = vi.fn(); window.addEventListener("llm-chat:offline-auth-required", auth);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "authentication_required", message: "login" } }), { status: 401 }));
    await expect(append()).rejects.toMatchObject({ status: 401 }); expect(auth).toHaveBeenCalledOnce();
    window.removeEventListener("llm-chat:offline-auth-required", auth);
    fetch.mockResolvedValueOnce(new Response("<html>proxy error</html>", { status: 502 }));
    await expect(append()).rejects.toMatchObject({ status: 502, code: "invalid_response" });
    fetch.mockResolvedValueOnce(new Response("{}", { status: 500 })); await expect(append()).rejects.toMatchObject({ code: "upload_failed" });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "disk_full", message: "disk full", i18n: { key: "uploads.disk_full" } } }), { status: 507 }));
    await expect(append()).rejects.toMatchObject({ code: "disk_full", message: expect.stringContaining("空间") });
  });
});
