import { expect, it, vi } from "vitest";
import { httpRequest, uploadFileHttp } from "./http-client";
import { saveRequestRetries } from "./request-preferences";
import { SERVER_CHANNELS_KEY } from "./server-channel";

it.each(["headers", "body"])("bounds a hung %s phase with the caller's deadline", async phase => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(() => phase === "headers" ? new Promise(() => {}) : Promise.resolve({ status: 200, ok: true, headers: new Headers(), text: () => new Promise(() => {}) })));
  const result = httpRequest("POST", "/api/test", {}, controller.signal);
  const check = expect(result).rejects.toMatchObject({ code: "request_timeout", status: 0 });
  await Promise.resolve(); controller.abort(new DOMException("deadline", "TimeoutError"));
  await check;
});

it("reports a lost response body as a network error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => { throw new TypeError("connection lost"); } })));
  await expect(httpRequest("POST", "/api/test", {}, new AbortController().signal)).rejects.toMatchObject({ code: "network_error" });
});

function useChannel(boundServerId: string | null) {
  localStorage.setItem(SERVER_CHANNELS_KEY, JSON.stringify({ channels: [CHANNEL], active: CHANNEL, boundServerId }));
  window.dispatchEvent(new StorageEvent("storage", { key: SERVER_CHANNELS_KEY }));
}
const CHANNEL = "http://localhost:4000";
const identified = (id: string, body: unknown = {}) => Response.json(body, { headers: { "x-llm-chat-server-id": id } });

it("sends requests and uploads through the active channel with its own credentials", async () => {
  useChannel("server");
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/api/identity") ? Response.json({ id: "server" }) : identified("server", { ok: true }));
  vi.stubGlobal("fetch", fetcher);
  await expect(httpRequest("GET", "/api/settings", undefined, new AbortController().signal)).resolves.toMatchObject({ data: { ok: true } });
  await uploadFileHttp(new File(["x"], "x.txt"));
  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.credentials])).toEqual([
    [`${CHANNEL}/api/identity`, "include"], [`${CHANNEL}/api/settings`, "include"], [`${CHANNEL}/api/files`, "include"]
  ]);
});

it("refuses a channel or response that reports another server without retrying", async () => {
  saveRequestRetries(2);
  useChannel("server");
  const fetcher = vi.fn(async (_url: string) => Response.json({ id: "other" }));
  vi.stubGlobal("fetch", fetcher);
  await expect(httpRequest("GET", "/api/settings", undefined, new AbortController().signal)).rejects.toMatchObject({ status: 409, code: "server_channel_mismatch" });
  await expect(uploadFileHttp(new File(["x"], "x.txt"))).rejects.toMatchObject({ code: "server_channel_mismatch" });
  // The identity check runs once per page; a mismatch sends nothing else.
  expect(fetcher).toHaveBeenCalledOnce();

  useChannel("server");
  fetcher.mockImplementation(async (url: string) => url.endsWith("/api/identity") ? Response.json({ id: "server" }) : identified("other"));
  await expect(httpRequest("POST", "/api/conversations", {}, new AbortController().signal)).rejects.toMatchObject({ code: "server_channel_mismatch" });
});

it("reports an unreachable channel as a retryable network error", async () => {
  useChannel("server");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  await expect(httpRequest("GET", "/api/settings", undefined, new AbortController().signal)).rejects.toMatchObject({ status: 0, code: "network_error" });
});
