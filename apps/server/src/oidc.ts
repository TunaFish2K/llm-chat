import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as client from "openid-client";
import { AuthError, type AuthManager } from "./auth";
import { configuredOrigin, type AuthenticationConfig } from "./auth-configuration";
import type { Store } from "./database";

export const OIDC_COOKIE = "llm_chat_oidc";
export const OIDC_CALLBACK = "/api/auth/oidc/callback";
export const OIDC_TRANSACTION_SECONDS = 600;
type Transaction = { browser_hash: string; verifier: string; nonce: string; origin: string; return_to: string };

/** The browser only carries an opaque transaction binding. All OIDC credentials stay server-side. */
export class OidcLogin {
  private discovery: Promise<client.Configuration> | undefined;

  constructor(private readonly store: Store, private readonly configuration: AuthenticationConfig) {}

  private async provider(): Promise<client.Configuration> {
    const oidc = this.configuration.oidc;
    if (!oidc) throw new AuthError(404, "oidc_disabled", "OIDC 登录未启用");
    if (!this.discovery) {
      this.discovery = (async () => {
        const secret = (await readFile(oidc.clientSecretFile, "utf8")).trim();
        if (!secret || /[\0\r\n]/.test(secret)) throw new Error("Invalid OIDC secret file");
        const server = new URL(oidc.issuer);
        const config = await client.discovery(server, oidc.clientId, undefined,
          oidc.clientAuthentication === "client_secret_basic" ? client.ClientSecretBasic(secret) : client.ClientSecretPost(secret),
          { timeout: 5, ...(server.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}) });
        if (config.serverMetadata().issuer !== oidc.issuer) throw new Error("OIDC issuer mismatch");
        client.enableNonRepudiationChecks(config);
        return config;
      })().catch(() => {
        this.discovery = undefined;
        throw new AuthError(503, "identity_provider_unavailable", "身份服务暂时不可用，请稍后重试或选择密码登录");
      });
    }
    return this.discovery;
  }

  async start(host: string | undefined, browser: string | undefined, returnTo: unknown, now = Date.now()) {
    const origin = configuredOrigin(this.configuration, host);
    if (!origin) throw new AuthError(400, "oidc_origin_invalid", "此入口未配置 OIDC 登录");
    const config = await this.provider();
    const target = safeReturnTo(returnTo);
    const binding = browser && /^[A-Za-z0-9_-]{43}$/.test(browser) ? browser : randomBytes(32).toString("base64url");
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: origin + OIDC_CALLBACK,
      scope: "openid profile",
      response_type: "code",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce
    });
    this.store.sqlite.prepare("DELETE FROM auth_oidc_transactions WHERE expires_at <= ?").run(now);
    this.store.sqlite.prepare(`INSERT INTO auth_oidc_transactions
      (state, browser_hash, verifier, nonce, origin, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(state, hash(binding), verifier, nonce, origin, target, now + OIDC_TRANSACTION_SECONDS * 1000);
    return { url: url.href, browser: binding, secure: new URL(origin).protocol === "https:" };
  }

  async callback(host: string | undefined, requestUrl: string, browser: string | undefined, auth: AuthManager, now = Date.now()) {
    const origin = configuredOrigin(this.configuration, host);
    if (!origin || !browser) throw new AuthError(400, "oidc_transaction_invalid", "登录请求无效或已过期，请重新登录");
    const url = new URL(requestUrl, origin);
    const state = url.searchParams.get("state");
    if (!state || url.searchParams.getAll("state").length !== 1) {
      throw new AuthError(400, "oidc_transaction_invalid", "登录请求无效或已过期，请重新登录");
    }
    // DELETE RETURNING atomically consumes the transaction before exchanging a code.
    const row = this.store.sqlite.prepare(`DELETE FROM auth_oidc_transactions
      WHERE state = ? AND browser_hash = ? AND origin = ? AND expires_at > ? RETURNING *`)
      .get(state, hash(browser), origin, now) as Transaction | undefined;
    if (!row) throw new AuthError(400, "oidc_transaction_invalid", "登录请求无效或已过期，请重新登录");
    const config = await this.provider();
    let subject: string;
    try {
      const tokens = await client.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: row.verifier,
        expectedState: state,
        expectedNonce: row.nonce,
        idTokenExpected: true
      });
      const claims = tokens.claims();
      if (!claims?.sub || claims.iss !== this.configuration.oidc!.issuer) throw new Error();
      subject = claims.sub;
    } catch {
      throw new AuthError(401, "oidc_login_failed", "统一登录验证失败，请重新登录");
    }
    return { ...auth.loginOidc(this.configuration.oidc!.issuer, subject, now), returnTo: row.return_to };
  }

  async logoutUrl(host: string | undefined): Promise<string | null> {
    const origin = configuredOrigin(this.configuration, host);
    if (!origin) return null;
    const config = await this.provider();
    if (!config.serverMetadata().end_session_endpoint) return null;
    // client_id is standard and avoids persisting an ID token solely for logout.
    return client.buildEndSessionUrl(config, { client_id: this.configuration.oidc!.clientId }).href;
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function safeReturnTo(value: unknown): string {
  if (value === undefined) return "/";
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\x00-\x20\x7f]/.test(value) || /%0[ad]|%5c/i.test(value)) {
    throw new AuthError(400, "return_to_invalid", "登录回跳必须是本站路径");
  }
  const url = new URL(value, "https://return.invalid");
  if (url.origin !== "https://return.invalid" || url.pathname.startsWith("/api/auth/")) {
    throw new AuthError(400, "return_to_invalid", "登录回跳必须是本站路径");
  }
  return url.pathname + url.search + url.hash;
}
