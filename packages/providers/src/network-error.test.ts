import { afterEach, describe, expect, it, vi } from "vitest";
import { describeNetworkError, providerFetch } from "./network-error";
import { readBoundedBytes, readSse } from "./http";
import { ProviderError } from "./types";

const fetchFailed = (code: string, message = code) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

afterEach(() => vi.unstubAllGlobals());

describe("network errors", () => {
  it.each([
    ["ENOTFOUND", "network_dns_error", "error.network_dns_error"],
    ["EAI_AGAIN", "network_dns_error", "error.network_dns_error"],
    ["ECONNREFUSED", "network_connection_refused", "error.network_connection_refused"],
    ["UND_ERR_CONNECT_TIMEOUT", "network_connect_timeout", "error.network_connect_timeout"],
    ["ETIMEDOUT", "network_connect_timeout", "error.network_connect_timeout"],
    ["ECONNRESET", "network_connection_reset", "error.network_connection_reset"],
    ["UND_ERR_SOCKET", "network_connection_reset", "error.network_connection_reset"],
    ["UND_ERR_HEADERS_TIMEOUT", "network_response_timeout", "error.network_response_timeout"],
    ["UND_ERR_BODY_TIMEOUT", "network_stream_timeout", "error.network_stream_timeout"],
    ["CERT_HAS_EXPIRED", "network_tls_error", "error.network_tls_error"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "network_tls_error", "error.network_tls_error"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "network_tls_error", "error.network_tls_error"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "network_tls_error", "error.network_tls_error"],
    ["EPROTO", "network_tls_error", "error.network_tls_error"],
    ["EHOSTUNREACH", "network_unreachable", "error.network_unreachable"],
    ["UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "request_too_large", "error.request_too_large"]
  ])("classifies %s", (cause, code, key) => {
    const error = describeNetworkError(fetchFailed(cause), "https://api.example.com/v1/chat");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, i18n: { key, params: { host: "api.example.com", detail: cause } } });
    expect(error!.message).not.toContain("fetch failed");
  });

  it("walks nested causes, timeouts, closed sockets and oversized bodies", () => {
    const nested = new TypeError("fetch failed", { cause: new Error("connect", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }) });
    expect(describeNetworkError(nested, "http://localhost:11434")).toMatchObject({ code: "network_connection_refused", message: expect.stringContaining("localhost:11434") });
    expect(describeNetworkError(new DOMException("timed out", "TimeoutError"), "https://x.test")).toMatchObject({ code: "network_timeout", status: 504 });
    expect(describeNetworkError(new TypeError("terminated", { cause: new Error("other side closed") }))).toMatchObject({ code: "network_connection_reset" });
    expect(describeNetworkError(new RangeError("Invalid string length"))).toMatchObject({ code: "request_too_large", status: 413 });
    expect(describeNetworkError(new TypeError("fetch failed", { cause: { name: "TimeoutError", message: "slow" } }))).toMatchObject({ code: "network_timeout" });
    expect(describeNetworkError(new TypeError("fetch failed", { cause: Object.assign(new Error("odd"), { code: "EWHATEVER" }) }), "https://x.test"))
      .toMatchObject({ code: "network_error", message: "请求 x.test 失败：EWHATEVER odd" });
    expect(describeNetworkError(new TypeError("fetch failed"), "not a url")).toMatchObject({ code: "network_error", message: expect.stringContaining("not a url") });
  });

  it("leaves aborts, provider errors and unrelated errors alone", () => {
    expect(describeNetworkError(new DOMException("aborted", "AbortError"))).toBeNull();
    expect(describeNetworkError(new ProviderError("provider_http_error", "bad"))).toBeNull();
    expect(describeNetworkError(new Error("plain"))).toBeNull();
    expect(describeNetworkError("text")).toBeNull();
  });

  it("wraps fetch rejections and passes responses through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(fetchFailed("ENOTFOUND")).mockResolvedValueOnce(new Response("ok")));
    await expect(providerFetch("https://missing.example/v1")).rejects.toMatchObject({ code: "network_dns_error", message: expect.stringContaining("missing.example") });
    await expect((await providerFetch("https://ok.example")).text()).resolves.toBe("ok");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new DOMException("aborted", "AbortError")));
    await expect(providerFetch("https://ok.example")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies a stream that drops mid-response", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode("data: one\n\n")); return; }
        controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
      }
    });
    const events: string[] = [];
    await expect((async () => { for await (const event of readSse(new Response(body))) events.push(event.data); })())
      .rejects.toMatchObject({ code: "network_connection_reset" });
    expect(events).toEqual(["one"]);
  });

  it("finds frame boundaries split across chunks without rescanning", async () => {
    const chunks = ["data: a", "\n", "\ndata: ", "b\n\ndata: c\r\n\r\n"];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
    const events: string[] = [];
    for await (const event of readSse(new Response(body))) events.push(event.data);
    expect(events).toEqual(["a", "b", "c"]);
  });

  it("reads bounded bodies and stops at the limit", async () => {
    const stream = (parts: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }));
    expect(new TextDecoder().decode((await readBoundedBytes(stream(["ab", "cd"]), 4))!)).toBe("abcd");
    expect(new TextDecoder().decode((await readBoundedBytes(stream(["abc"]), 4))!)).toBe("abc");
    await expect(readBoundedBytes(stream(["ab", "cde"]), 4)).resolves.toBeNull();
    await expect(readBoundedBytes(new Response(null), 4)).resolves.toEqual(new Uint8Array());
    const broken = new Response(new ReadableStream({ pull(controller) { controller.error(fetchFailed("ECONNRESET")); } }));
    await expect(readBoundedBytes(broken, 4)).rejects.toMatchObject({ code: "network_connection_reset" });
    const odd = new Response(new ReadableStream({ pull(controller) { controller.error(new Error("odd")); } }));
    await expect(readBoundedBytes(odd, 4)).rejects.toThrow("odd");
  });
});
