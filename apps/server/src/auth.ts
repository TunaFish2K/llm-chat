import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Store } from "./database";

const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;

type Row = Record<string, unknown>;

export interface AuthIdentity {
  sessionId: string;
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
    private readonly announce: (message: string) => void
  ) {}

  async ensurePassword(now = Date.now()): Promise<string | null> {
    if (this.passwordRow()) return null;
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
    const row = this.passwordRow();
    if (!row || !await verifyPassword(password, row)) {
      throw new AuthError(401, "password_invalid", "密码错误");
    }
    return { token: this.issueSession(now) };
  }

  authenticate(token: string | undefined, now = Date.now()): AuthIdentity | null {
    if (!token) return null;
    const row = this.store.sqlite.prepare(`
      SELECT id, expires_at, last_used_at
      FROM auth_password_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(secretHash(token), now) as Row | undefined;
    if (!row) return null;
    let expiresAt = Number(row.expires_at);
    let refreshCookie = false;
    if (now - Number(row.last_used_at) >= SESSION_TOUCH_INTERVAL_MS) {
      expiresAt = now + SESSION_TTL_MS;
      refreshCookie = true;
      this.store.sqlite.prepare(`
        UPDATE auth_password_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?
      `).run(now, expiresAt, String(row.id));
    }
    return { sessionId: String(row.id), expiresAt, refreshCookie };
  }

  async changePassword(sessionId: string, password: string, now = Date.now()): Promise<{
    token: string;
    sessionsRevoked: number;
  }> {
    const session = this.store.sqlite.prepare(`
      SELECT id FROM auth_password_sessions
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(sessionId, now);
    if (!session) throw new AuthError(401, "authentication_required", "请重新登录");
    const encoded = await encodePassword(password);
    const token = randomSecret();
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.store.sqlite.prepare(`
        UPDATE auth_password SET salt = ?, password_hash = ?, changed_at = ? WHERE id = 1
      `).run(encoded.salt, encoded.hash, now);
      const sessionsRevoked = Number(this.store.sqlite.prepare(`
        UPDATE auth_password_sessions SET revoked_at = ? WHERE revoked_at IS NULL
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
      UPDATE auth_password_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now, secretHash(token));
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
      INSERT INTO auth_password_sessions (id, token_hash, created_at, last_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
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
      UPDATE auth_password_sessions SET revoked_at = ? WHERE revoked_at IS NULL
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
