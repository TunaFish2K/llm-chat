import { describe, expect, it } from "vitest";
import { isLoopbackHostname, parseRuntimeConfig } from "./config";

const projectRoot = "/srv/llm-chat";

describe("runtime config", () => {
  it("uses production-safe defaults and surfaces the build identifier", () => {
    expect(parseRuntimeConfig({}, projectRoot)).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      dataDir: "/srv/llm-chat/data",
      authMode: "webauthn",
      publicUrl: "http://localhost:3000",
      rpId: "localhost",
      serveWeb: true,
      shutdownTimeoutMs: 30_000,
      buildId: "development",
      webRoot: "/srv/llm-chat/apps/web/dist"
    });
    expect(parseRuntimeConfig({ LLM_CHAT_BUILD_ID: "release-42" }, projectRoot).buildId).toBe("release-42");
  });

  it("accepts only explicit boolean values for web serving", () => {
    expect(parseRuntimeConfig({ LLM_CHAT_SERVE_WEB: "true" }, projectRoot).serveWeb).toBe(true);
    expect(parseRuntimeConfig({ LLM_CHAT_SERVE_WEB: "false" }, projectRoot).serveWeb).toBe(false);
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(() => parseRuntimeConfig({ LLM_CHAT_SERVE_WEB: value }, projectRoot)).toThrow("LLM_CHAT_SERVE_WEB");
    }
  });

  it("strictly validates and bounds the shutdown deadline", () => {
    expect(parseRuntimeConfig({ LLM_CHAT_SHUTDOWN_TIMEOUT_MS: "15000" }, projectRoot).shutdownTimeoutMs).toBe(15_000);
    for (const value of ["999", "300001", "1.5", "01", "-1", "Infinity", ""]) {
      expect(() => parseRuntimeConfig({ LLM_CHAT_SHUTDOWN_TIMEOUT_MS: value }, projectRoot)).toThrow("LLM_CHAT_SHUTDOWN_TIMEOUT_MS");
    }
  });

  it("allows disabled auth only when both addresses are loopback", () => {
    expect(parseRuntimeConfig({
      LLM_CHAT_AUTH_MODE: "disabled",
      LLM_CHAT_HOST: "127.0.0.2",
      LLM_CHAT_PUBLIC_URL: "http://localhost:3000"
    }, projectRoot).authMode).toBe("disabled");
    expect(() => parseRuntimeConfig({
      LLM_CHAT_AUTH_MODE: "disabled",
      LLM_CHAT_HOST: "0.0.0.0"
    }, projectRoot)).toThrow("仅允许回环");
    expect(() => parseRuntimeConfig({
      LLM_CHAT_AUTH_MODE: "disabled",
      LLM_CHAT_PUBLIC_URL: "https://chat.example.com"
    }, projectRoot)).toThrow("仅允许回环");
  });

  it("preserves remote WebAuthn HTTPS and RP validation", () => {
    expect(parseRuntimeConfig({
      LLM_CHAT_HOST: "0.0.0.0",
      LLM_CHAT_PUBLIC_URL: "https://chat.example.com",
      LLM_CHAT_RP_ID: "example.com"
    }, projectRoot).rpId).toBe("example.com");
    expect(() => parseRuntimeConfig({ LLM_CHAT_HOST: "0.0.0.0" }, projectRoot)).toThrow("LLM_CHAT_PUBLIC_URL");
    expect(() => parseRuntimeConfig({
      LLM_CHAT_HOST: "0.0.0.0",
      LLM_CHAT_PUBLIC_URL: "http://chat.example.com"
    }, projectRoot)).toThrow("HTTPS");
    expect(() => parseRuntimeConfig({
      LLM_CHAT_PUBLIC_URL: "https://chat.example.com",
      LLM_CHAT_RP_ID: "other.example"
    }, projectRoot)).toThrow("LLM_CHAT_RP_ID");
  });

  it("recognizes common IPv4 and IPv6 loopback hosts", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.255.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});
