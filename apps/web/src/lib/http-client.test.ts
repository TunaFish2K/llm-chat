import { expect, it, vi } from "vitest";
import { httpRequest } from "./http-client";

it.each(["headers", "body"])("bounds a hung %s phase with the caller's deadline", async phase => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(() => phase === "headers" ? new Promise(() => {}) : Promise.resolve({ status: 200, ok: true, text: () => new Promise(() => {}) })));
  const result = httpRequest("POST", "/api/test", {}, controller.signal);
  const check = expect(result).rejects.toMatchObject({ code: "request_timeout", status: 0 });
  await Promise.resolve(); controller.abort(new DOMException("deadline", "TimeoutError"));
  await check;
});

it("reports a lost response body as a network error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, text: async () => { throw new TypeError("connection lost"); } })));
  await expect(httpRequest("POST", "/api/test", {}, new AbortController().signal)).rejects.toMatchObject({ code: "network_error" });
});
