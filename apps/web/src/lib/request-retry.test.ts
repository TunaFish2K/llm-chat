import { afterEach, expect, it, vi } from "vitest";
import { ApiRequestError, httpRequest, resetRequestSession, uploadFileHttp } from "./http-client";
import { DEFAULT_REQUEST_RETRIES, REQUEST_PREFERENCES_KEY, requestRetries, saveRequestRetries } from "./request-preferences";
import { retryable, retryDelay, retryRequest, retryWait } from "./request-retry";

afterEach(() => { vi.useRealTimers(); resetRequestSession(); });

it("defaults to two retries, validates stored values, and keeps a choice when storage is unavailable", () => {
  localStorage.removeItem(REQUEST_PREFERENCES_KEY);
  expect(requestRetries()).toBe(DEFAULT_REQUEST_RETRIES);
  for (const value of [-1, 6, 1.2, "2", null]) {
    localStorage.setItem(REQUEST_PREFERENCES_KEY, JSON.stringify({ maxRetries: value }));
    expect(requestRetries()).toBe(2);
  }
  localStorage.setItem(REQUEST_PREFERENCES_KEY, "{"); expect(requestRetries()).toBe(2);
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  saveRequestRetries(5); expect(requestRetries()).toBe(5);
  write.mockRestore(); saveRequestRetries(1); expect(requestRetries()).toBe(1);
  localStorage.setItem(REQUEST_PREFERENCES_KEY, JSON.stringify({ maxRetries: 0 }));
  window.dispatchEvent(new StorageEvent("storage", { key: REQUEST_PREFERENCES_KEY }));
  expect(requestRetries()).toBe(0);
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  expect(requestRetries()).toBe(0);
});

it("retries only network, timeout and transient HTTP failures", () => {
  for (const status of [0, 408, 429, 500, 502, 503, 504]) expect(retryable({ status })).toBe(true);
  for (const error of [null, false, new Error("invalid input"), { status: 400 }, { status: 401 }, { status: 409 }, { status: 0, code: "request_cancelled" }]) expect(retryable(error)).toBe(false);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([500, 1500, 3000, 4000, 4000]);
});

it("makes at most three attempts by default, using the same body and command id", async () => {
  vi.useFakeTimers(); saveRequestRetries(2);
  const body = { text: "original" };
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503, headers: { "retry-after": "0" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })));
  vi.stubGlobal("fetch", fetch);
  const request = httpRequest("POST", "/api/test", body, new AbortController().signal);
  body.text = "new draft";
  await vi.runAllTimersAsync();
  await expect(request).resolves.toMatchObject({ data: { accepted: true } });
  expect(fetch).toHaveBeenCalledTimes(3);
  const attempts = fetch.mock.calls.map(call => call[1] as RequestInit);
  expect(new Set(attempts.map(value => (value.headers as Record<string, string>)["x-llm-chat-request-id"])).size).toBe(1);
  expect(attempts.every(value => value.body === JSON.stringify({ text: "original" }))).toBe(true);
});

it("stops after the configured count, and stops a scheduled retry on cancellation", async () => {
  vi.useFakeTimers(); saveRequestRetries(2);
  const action = vi.fn().mockRejectedValue(new ApiRequestError(0, "network_error", "offline"));
  const request = retryRequest(action, new AbortController().signal);
  const failed = expect(request).rejects.toMatchObject({ code: "network_error" });
  await vi.runAllTimersAsync(); await failed;
  expect(action).toHaveBeenCalledTimes(3);
  action.mockClear();
  const controller = new AbortController();
  const pending = retryRequest(action, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0); controller.abort();
  await vi.runAllTimersAsync(); await cancelled;
  expect(action).toHaveBeenCalledTimes(1);
});

it("bounds Retry-After and never retries a permanent failure", async () => {
  vi.useFakeTimers();
  const action = vi.fn().mockRejectedValueOnce({ status: 429, retryAfterMs: 60_000 }).mockResolvedValue("done");
  const request = retryRequest(action, new AbortController().signal, 1);
  await vi.advanceTimersByTimeAsync(9_999); expect(action).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await expect(request).resolves.toBe("done");
  const invalid = vi.fn().mockRejectedValue({ status: 409 });
  await expect(retryRequest(invalid, new AbortController().signal, 5)).rejects.toEqual({ status: 409 });
  expect(invalid).toHaveBeenCalledTimes(1);
  const aborted = new AbortController(); aborted.abort();
  expect(() => retryWait(500, aborted.signal)).toThrow();
});

it("changing authentication cancels a write and all of its retries", async () => {
  vi.useFakeTimers(); saveRequestRetries(2);
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetch);
  const request = httpRequest("PATCH", "/api/test", {}, new AbortController().signal);
  const failed = expect(request).rejects.toMatchObject({ code: "request_cancelled" });
  await vi.advanceTimersByTimeAsync(0); resetRequestSession();
  await vi.runAllTimersAsync(); await failed;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retries a raw file upload without changing its bytes or id", async () => {
  vi.useFakeTimers(); saveRequestRetries(2);
  const file = new File(["same bytes"], "test.txt", { type: "text/plain" });
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("lost"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "asset" })));
  vi.stubGlobal("fetch", fetch);
  const request = uploadFileHttp(file);
  await vi.runAllTimersAsync(); await expect(request).resolves.toMatchObject({ id: "asset" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1].body).toBe(file);
  expect(fetch.mock.calls[1]![1].headers).toEqual(fetch.mock.calls[0]![1].headers);
});
