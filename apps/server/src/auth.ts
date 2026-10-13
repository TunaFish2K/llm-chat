import { DEFAULT_AUTHENTICATION, type AuthenticationConfig } from "./auth-configuration";
import { withMessage } from "@llm-chat/i18n";
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Store } from "./database";

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;

type Row = Record<string, unknown>;

export interface AuthIdentity {
  sessionId: string;
  method: "password" | "oidc";
  issuer?: string;
  subject?: string;
  expiresAt: number;
  refreshCookie: boolean;
}

export class AuthError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface PasswordResetResult {
  password: string;
  sessionsRevoked: number;
}

export class AuthManager {
  constructor(
    private readonly store: Store,
    private readonly announce: (message: string) => void,
    private readonly configuration: AuthenticationConfig = DEFAULT_AUTHENTICATION
  ) {}

  async ensurePassword(now = Date.now()): Promise<string | null> {
    if (!this.configuration.password.enabled || this.passwordRow()) return null;
    const password = initialPassword();
    const encoded = await encodePassword(password);
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (this.passwordRow()) {
        this.store.sqlite.exec("COMMIT");
        return null;
      }
      this.store.sqlite.prepare(`
        INSERT INTO auth_password (id, salt, password_hash, changed_at)
        VALUES (1, ?, ?, ?)
      `).run(encoded.salt, encoded.hash, now);
      this.store.sqlite.exec("COMMIT");
    } catch (error) {
      this.store.sqlite.exec("ROLLBACK");
      throw error;
    }
    this.announce(`llm-chat 初始登录密码：${password}\n请登录后在“设置 > 安全”中修改。`);
    return password;
  }

  async login(password: string, now = Date.now()): Promise<{ token: string }> {
    if (!this.configuration.password.enabled) throw new AuthError(404, "password_login_disabled", "密码登录未启用");
    const row = this.passwordRow();
    if (!row || !await verifyPassword(password, row)) {
      throw withMessage(new AuthError(401, "password_invalid", "密码错误"), "error.incorrect_password");
    }
    return { token: this.issueSession(now) };
  }

  authenticate(token: string | undefined, now = Date.now()): AuthIdentity | null {
    if (!token) return null;
    const row = this.store.sqlite.prepare(`
      SELECT id, expires_at, last_used_at, method, issuer, subject, client_id
      FROM auth_browser_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(secretHash(token), now) as Row | undefined;
    if (!row) return null;
    if (row.method === "password" && !this.configuration.password.enabled) return null;
    if (row.method === "oidc" && (!this.configuration.oidc
      || row.issuer !== this.configuration.oidc.issuer
      || row.client_id !== this.configuration.oidc.clientId
      || !this.configuration.oidc.allowedSubjects.includes(String(row.subject)))) return null;
    let expiresAt = Number(row.expires_at);
    let refreshCookie = false;
    if (now - Number(row.last_used_at) >= SESSION_TOUCH_INTERVAL_MS) {
      expiresAt = now + SESSION_TTL_MS;
      refreshCookie = true;
      this.store.sqlite.prepare(`
        UPDATE auth_browser_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?
      `).run(now, expiresAt, String(row.id));
    }
    return { sessionId: String(row.id), method: row.method as AuthIdentity["method"],
      ...(row.method === "oidc" ? { issuer: String(row.issuer), subject: String(row.subject) } : {}), expiresAt, refreshCookie };
  }

  async changePassword(sessionId: string, password: string, now = Date.now()): Promise<{
    token: string;
    sessionsRevoked: number;
  }> {
    if (!this.configuration.password.enabled) throw new AuthError(404, "password_login_disabled", "密码登录未启用");
    const session = this.store.sqlite.prepare(`
      SELECT id FROM auth_browser_sessions
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(sessionId, now);
    if (!session) throw withMessage(new AuthError(401, "authentication_required", "请重新登录"), "error.sign_in_again");
    const encoded = await encodePassword(password);
    const token = randomSecret();
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.store.sqlite.prepare(`
        UPDATE auth_password SET salt = ?, password_hash = ?, changed_at = ? WHERE id = 1
      `).run(encoded.salt, encoded.hash, now);
      const sessionsRevoked = Number(this.store.sqlite.prepare(`
        UPDATE auth_browser_sessions SET revoked_at = ? WHERE revoked_at IS NULL
      `).run(now).changes);
      this.insertSession(token, now);
      this.store.sqlite.exec("COMMIT");
      return { token, sessionsRevoked };
    } catch (error) {
      this.store.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  logout(token: string | undefined, now = Date.now()): void {
    if (!token) return;
    this.store.sqlite.prepare(`
      UPDATE auth_browser_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now, secretHash(token));
  }

  loginOidc(issuer: string, subject: string, now = Date.now()): { token: string } {
    const config = this.configuration.oidc;
    if (!config || issuer !== config.issuer || !config.allowedSubjects.includes(subject)) {
      throw new AuthError(403, "identity_not_allowed", "此身份未获准访问此实例");
    }
    const token = randomSecret();
    this.store.sqlite.prepare(`
      INSERT INTO auth_browser_sessions (id, token_hash, created_at, last_used_at, expires_at, method, issuer, subject, client_id)
      VALUES (?, ?, ?, ?, ?, 'oidc', ?, ?, ?)
    `).run(randomUUID(), secretHash(token), now, now, now + SESSION_TTL_MS, issuer, subject, config.clientId);
    return { token };
  }

  private passwordRow(): Row | undefined {
    return this.store.sqlite.prepare("SELECT salt, password_hash FROM auth_password WHERE id = 1").get() as Row | undefined;
  }

  private issueSession(now: number): string {
    const token = randomSecret();
    this.insertSession(token, now);
    return token;
  }

  private insertSession(token: string, now: number): void {
    this.store.sqlite.prepare(`
      INSERT INTO auth_browser_sessions (id, token_hash, created_at, last_used_at, expires_at, method)
      VALUES (?, ?, ?, ?, ?, 'password')
    `).run(randomUUID(), secretHash(token), now, now, now + SESSION_TTL_MS);
  }
}

export async function resetPassword(store: Store, now = Date.now()): Promise<PasswordResetResult> {
  const password = initialPassword();
  const encoded = await encodePassword(password);
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    store.sqlite.prepare(`
      INSERT INTO auth_password (id, salt, password_hash, changed_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        salt = excluded.salt,
        password_hash = excluded.password_hash,
        changed_at = excluded.changed_at
    `).run(encoded.salt, encoded.hash, now);
    const sessionsRevoked = Number(store.sqlite.prepare(`
      UPDATE auth_browser_sessions SET revoked_at = ? WHERE revoked_at IS NULL
    `).run(now).changes);
    store.sqlite.exec("COMMIT");
    return { password, sessionsRevoked };
  } catch (error) {
    store.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function encodePassword(password: string): Promise<{ salt: Buffer; hash: Buffer }> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: Buffer.from(derivedKey) });
    });
  });
}

function verifyPassword(password: string, row: Row): Promise<boolean> {
  const salt = Buffer.from(row.salt as Uint8Array);
  const expected = Buffer.from(row.password_hash as Uint8Array);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, expected.byteLength, (error, derivedKey) => {
      if (error) reject(error);
      else {
        const actual = Buffer.from(derivedKey);
        resolve(actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected));
      }
    });
  });
}

function initialPassword(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
