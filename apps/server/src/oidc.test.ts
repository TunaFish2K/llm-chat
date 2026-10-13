import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthManager } from "./auth";
import { parseAuthentication } from "./auth-configuration";
import { Store } from "./database";
import { OIDC_CALLBACK, OidcLogin, safeReturnTo } from "./oidc";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(clientAuthentication: "client_secret_basic" | "client_secret_post" = "client_secret_basic") {
  const directory = mkdtempSync(join(tmpdir(), "llm-chat-oidc-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "store.sqlite"));
  cleanup.push(() => store.close());
  writeFileSync(join(directory, "secret"), "test-client-secret");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" };
  let issuer = "";
  let nonce = "";
  let challenge = "";
  let exchanges = 0;
  let claims: Record<string, unknown> = {};
  let badSignature = false;
  const server: Server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") {
      return response.end(JSON.stringify({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks", end_session_endpoint: issuer + "/logout", response_types_supported: ["code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] }));
    }
    if (request.url === "/jwks") return response.end(JSON.stringify({ keys: [jwk] }));
    if (request.url === "/token") {
      exchanges++;
      let body = "";
      for await (const chunk of request) body += chunk;
      const fields = new URLSearchParams(body);
      const actualBasic = request.headers.authorization?.startsWith("Basic ")
        ? decodeURIComponent(Buffer.from(request.headers.authorization.slice(6), "base64").toString()) : "";
      if (clientAuthentication === "client_secret_basic" ? actualBasic !== "llm-chat:test-client-secret"
        : fields.get("client_id") !== "llm-chat" || fields.get("client_secret") !== "test-client-secret") {
        response.statusCode = 401;
        return response.end(JSON.stringify({ error: "invalid_client" }));
      }
      const actualChallenge = createHash("sha256").update(fields.get("code_verifier") ?? "").digest("base64url");
      if (actualChallenge !== challenge || fields.get("redirect_uri") !== "https://chat.example.com" + OIDC_CALLBACK) {
        response.statusCode = 400;
        return response.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, sub: "owner", aud: "llm-chat", exp: now + 300, iat: now, nonce, ...claims };
      const unsigned = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url") + "."
        + Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createSign("RSA-SHA256").update(unsigned).sign(keys.privateKey).toString("base64url");
      return response.end(JSON.stringify({ token_type: "Bearer", access_token: "test-access", expires_in: 300,
        id_token: unsigned + "." + (badSignature ? "AAAA" : signature) }));
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing mock address");
  issuer = `http://127.0.0.1:${address.port}`;
  const configuration = parseAuthentication({ oidc: { issuer, clientId: "llm-chat", clientSecretFile: "secret",
    publicOrigins: ["https://chat.example.com"], allowedSubjects: ["owner"], clientAuthentication } }, join(directory, "config.json"));
  const oidc = new OidcLogin(store, configuration);
  const auth = new AuthManager(store, () => {}, configuration);
  async function start(returnTo = "/settings/security") {
    const login = await oidc.start("chat.example.com", undefined, returnTo);
    const url = new URL(login.url);
    nonce = url.searchParams.get("nonce")!;
    challenge = url.searchParams.get("code_challenge")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    return { ...login, callback: OIDC_CALLBACK + "?code=test&state=" + url.searchParams.get("state") };
  }
  return { auth, oidc, configuration, store, start, issuer, exchanges: () => exchanges,
    setClaims: (value: Record<string, unknown>) => { claims = value; }, corruptSignature: () => { badSignature = true; } };
}

describe("standard OIDC login", () => {
  it.each(["client_secret_basic", "client_secret_post"] as const)("uses discovery and verified tokens with %s", async (method) => {
    const f = await fixture(method);
    const login = await f.start();
    const result = await f.oidc.callback("chat.example.com", login.callback, login.browser, f.auth);
    expect(result.returnTo).toBe("/settings/security");
    expect(f.auth.authenticate(result.token)).toMatchObject({ method: "oidc", issuer: f.issuer, subject: "owner" });
    expect(await f.oidc.logoutUrl("chat.example.com")).toBe(f.issuer + "/logout?client_id=llm-chat");
    await expect(f.oidc.callback("chat.example.com", login.callback, login.browser, f.auth)).rejects.toMatchObject({ code: "oidc_transaction_invalid" });
    expect(f.exchanges()).toBe(1);
  });

  it.each([{ aud: "other-client" }, { iss: "https://other.example" }, { nonce: "wrong" }, { exp: 1 }])("rejects invalid ID token claims %j", async (claims) => {
    const f = await fixture();
    const login = await f.start();
    f.setClaims(claims);
    await expect(f.oidc.callback("chat.example.com", login.callback, login.browser, f.auth)).rejects.toMatchObject({ code: "oidc_login_failed" });
  });

  it("rejects invalid signatures and identities outside the allowlist", async () => {
    const f = await fixture();
    const first = await f.start();
    f.setClaims({ sub: "other-user", email: "owner@example.com" });
    await expect(f.oidc.callback("chat.example.com", first.callback, first.browser, f.auth)).rejects.toMatchObject({ code: "identity_not_allowed" });
    const second = await f.start();
    f.corruptSignature();
    await expect(f.oidc.callback("chat.example.com", second.callback, second.browser, f.auth)).rejects.toMatchObject({ code: "oidc_login_failed" });
  });

  it("binds state to the browser and entrance and expires transactions", async () => {
    const f = await fixture();
    const login = await f.start();
    for (const [host, browser, url] of [["other.example.com", login.browser, login.callback], ["chat.example.com", "wrong-browser", login.callback], ["chat.example.com", login.browser, login.callback + "&state=duplicate"]]) {
      await expect(f.oidc.callback(host, url!, browser, f.auth)).rejects.toMatchObject({ code: "oidc_transaction_invalid" });
    }
    await expect(f.oidc.callback("chat.example.com", login.callback, login.browser, f.auth, Date.now() + 601_000)).rejects.toMatchObject({ code: "oidc_transaction_invalid" });
    expect(f.exchanges()).toBe(0);
    await expect(f.oidc.start("forged.example.com", undefined, "/")).rejects.toMatchObject({ code: "oidc_origin_invalid" });
  });

  it("keeps password login available, revokes both methods, and rechecks the allowlist", async () => {
    const f = await fixture();
    const password = await f.auth.ensurePassword();
    const local = await f.auth.login(password!);
    const login = await f.start();
    const external = await f.oidc.callback("chat.example.com", login.callback, login.browser, f.auth);
    const identity = f.auth.authenticate(local.token)!;
    const replacement = await f.auth.changePassword(identity.sessionId, "changed-password");
    expect(replacement.sessionsRevoked).toBe(2);
    expect(f.auth.authenticate(external.token)).toBeNull();
    const next = f.auth.loginOidc(f.issuer, "owner");
    f.configuration.oidc!.allowedSubjects = ["replacement-owner"];
    expect(f.auth.authenticate(next.token)).toBeNull();
    f.configuration.password.enabled = false;
    await expect(f.auth.login("changed-password")).rejects.toMatchObject({ code: "password_login_disabled" });
    expect(f.auth.authenticate(replacement.token)).toBeNull();
  });
});

describe("authentication deployment configuration", () => {
  it.each(["https://evil.example", "//evil.example", "/\\evil", "/%0aLocation:evil", "/api/auth/oidc/start"])("rejects unsafe return path %s", (path) => {
    expect(() => safeReturnTo(path)).toThrow();
  });
  it("keeps safe local paths and validates secure origins and explicit subjects", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("/chat?conversation=one#last")).toBe("/chat?conversation=one#last");
    expect(() => parseAuthentication({ password: { enabled: false } }, "/config.json")).toThrow();
    const oidc = { issuer: "https://id.example/issuer", clientId: "chat", clientSecretFile: "secret", publicOrigins: ["https://chat.example"], allowedSubjects: ["owner"] };
    expect(parseAuthentication({ oidc }, "/etc/chat/config.json").oidc!.clientSecretFile).toBe("/etc/chat/secret");
    for (const patch of [{ publicOrigins: ["http://chat.example"] }, { publicOrigins: ["https://chat.example/path"] }, { issuer: "http://id.example" }, { allowedSubjects: [] }, { extra: true }]) {
      expect(() => parseAuthentication({ oidc: { ...oidc, ...patch } }, "/config.json")).toThrow();
    }
  });
});
