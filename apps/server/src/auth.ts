import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from "@simplewebauthn/server";
import QRCode from "qrcode";
import type { Store } from "./database";

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

export interface AuthConfig {
  origin: string;
  rpId: string;
  rpName?: string;
}

export interface AuthIdentity {
  sessionId: string;
  credentialId: string;
  name: string;
  expiresAt: number;
  refreshCookie: boolean;
}

export interface AuthDeviceDto {
  id: string;
  name: string;
  current: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  approvedByName: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export class AuthError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export class AuthManager {
  private readonly origin: string;
  private readonly rpId: string;
  private readonly rpName: string;
  private bootstrapRequest: { url: string; expiresAt: number } | undefined;

  constructor(
    private readonly store: Store,
    config: AuthConfig,
    private readonly announce: (message: string) => void
  ) {
    this.origin = new URL(config.origin).origin;
    this.rpId = config.rpId;
    this.rpName = config.rpName ?? "llm-chat";
  }

  async ensureBootstrapRequest(now = Date.now()): Promise<string | null> {
    if (this.activeCredentialCount() > 0) {
      this.bootstrapRequest = undefined;
      return null;
    }
    if (this.bootstrapRequest && this.bootstrapRequest.expiresAt > now) return this.bootstrapRequest.url;
    this.store.sqlite.prepare(`
      UPDATE auth_enrollment_requests SET status = 'expired'
      WHERE kind = 'bootstrap' AND status != 'redeemed'
    `).run();
    const id = randomUUID();
    const secret = randomSecret();
    this.store.sqlite.prepare(`
      INSERT INTO auth_enrollment_requests
        (id, kind, status, device_name, approval_secret_hash, created_at, expires_at)
      VALUES (?, 'bootstrap', 'created', '首台可信设备', ?, ?, ?)
    `).run(id, secretHash(secret), now, now + BOOTSTRAP_TTL_MS);
    const url = `${this.origin}/pair#mode=bootstrap&request=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;
    this.bootstrapRequest = { url, expiresAt: now + BOOTSTRAP_TTL_MS };
    const terminalQr = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" });
    this.announce(`首次设备配对（10 分钟内有效）\n${terminalQr}\n${url}`);
    return url;
  }

  async bootstrapOptions(id: string, secret: string, now = Date.now()): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (this.activeCredentialCount() > 0) throw new AuthError(409, "bootstrap_complete", "首台可信设备已经注册");
    const request = this.enrollmentBySecret(id, secret, "bootstrap", now);
    const options = await this.registrationOptions();
    this.store.sqlite.prepare("UPDATE auth_enrollment_requests SET registration_challenge = ? WHERE id = ?")
      .run(options.challenge, String(request.id));
    return options;
  }

  async verifyBootstrap(input: {
    id: string;
    secret: string;
    deviceName: string;
    response: RegistrationResponseJSON;
  }, now = Date.now()): Promise<{ token: string }> {
    if (this.activeCredentialCount() > 0) throw new AuthError(409, "bootstrap_complete", "首台可信设备已经注册");
    const request = this.enrollmentBySecret(input.id, input.secret, "bootstrap", now);
    const info = await this.verifyRegistration(request, input.response);
    const credentialRowId = randomUUID();
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (this.activeCredentialCount() > 0) throw new AuthError(409, "bootstrap_complete", "首台可信设备已经注册");
      this.insertCredential(credentialRowId, cleanName(input.deviceName), null, info, input.response, now);
      const consumed = this.store.sqlite.prepare(`
        UPDATE auth_enrollment_requests
        SET status = 'redeemed', consumed_at = ?, device_name = ? WHERE id = ? AND status = 'created'
      `).run(now, cleanName(input.deviceName), String(request.id));
      if (!Number(consumed.changes)) throw new AuthError(409, "bootstrap_already_used", "首次设备注册请求已经使用");
      const token = this.issueSession(credentialRowId, now);
      this.store.sqlite.exec("COMMIT");
      this.bootstrapRequest = undefined;
      return { token };
    } catch (error) {
      this.store.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async beginEnrollment(input: { deviceName: string; ip: string; userAgent: string }, now = Date.now()): Promise<{
    id: string;
    tabSecret: string;
    approvalSecret: string;
    options: PublicKeyCredentialCreationOptionsJSON;
    expiresAt: number;
  }> {
    if (this.activeCredentialCount() === 0) throw new AuthError(409, "bootstrap_required", "请先用终端二维码注册首台可信设备");
    const id = randomUUID();
    const tabSecret = randomSecret();
    const approvalSecret = randomSecret();
    const options = await this.registrationOptions();
    const expiresAt = now + ENROLLMENT_TTL_MS;
    this.store.sqlite.prepare(`
      INSERT INTO auth_enrollment_requests (
        id, kind, status, device_name, registration_challenge, tab_secret_hash,
        approval_secret_hash, request_ip, user_agent, created_at, expires_at
      ) VALUES (?, 'device', 'created', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, cleanName(input.deviceName), options.challenge, secretHash(tabSecret), secretHash(approvalSecret),
      input.ip.slice(0, 128), input.userAgent.slice(0, 300), now, expiresAt
    );
    return { id, tabSecret, approvalSecret, options, expiresAt };
  }

  async finishEnrollment(input: {
    id: string;
    tabSecret: string;
    approvalSecret: string;
    response: RegistrationResponseJSON;
  }, now = Date.now()): Promise<{ approvalQr: string; expiresAt: number }> {
    const request = this.enrollmentByTabSecret(input.id, input.tabSecret, now, "created");
    if (secretHash(input.approvalSecret) !== String(request.approval_secret_hash)) {
      throw new AuthError(401, "enrollment_invalid", "配对请求无效");
    }
    const info = await this.verifyRegistration(request, input.response);
    const existing = this.store.sqlite.prepare("SELECT id FROM auth_credentials WHERE credential_id = ?")
      .get(info.credential.id);
    if (existing) throw new AuthError(409, "credential_exists", "此 Passkey 已经注册");
    const result = this.store.sqlite.prepare(`
      UPDATE auth_enrollment_requests SET
        status = 'awaiting_approval', pending_credential_id = ?, pending_public_key = ?,
        pending_counter = ?, pending_transports_json = ?, pending_device_type = ?, pending_backed_up = ?
      WHERE id = ? AND status = 'created'
    `).run(
      info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter,
      JSON.stringify(input.response.response.transports ?? []), info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0, String(request.id)
    );
    if (!Number(result.changes)) throw new AuthError(409, "enrollment_already_used", "此配对请求已经处理");
    const approvalUrl = `${this.origin}/pair#mode=approve&request=${encodeURIComponent(String(request.id))}&secret=${encodeURIComponent(input.approvalSecret)}`;
    return { approvalQr: await QRCode.toDataURL(approvalUrl, { width: 320, margin: 2, errorCorrectionLevel: "M" }), expiresAt: Number(request.expires_at) };
  }

  approvalDetails(id: string, secret: string, now = Date.now()): {
    id: string;
    deviceName: string;
    browser: string;
    ip: string;
    expiresAt: number;
  } {
    const request = this.enrollmentBySecret(id, secret, "device", now, "awaiting_approval");
    return {
      id: String(request.id),
      deviceName: String(request.device_name),
      browser: describeBrowser(String(request.user_agent ?? "")),
      ip: String(request.request_ip ?? "未知"),
      expiresAt: Number(request.expires_at)
    };
  }

  async approvalOptions(id: string, secret: string, now = Date.now()): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const request = this.enrollmentBySecret(id, secret, "device", now, "awaiting_approval");
    const credentials = this.activeCredentialRows();
    const boundChallenge = createHash("sha256").update(Buffer.concat([
      Buffer.from("llm-chat-approve-v1\0", "utf8"), randomBytes(32), Buffer.from(String(request.id), "utf8"),
      Buffer.from(String(request.pending_credential_id), "utf8"), Buffer.from(request.pending_public_key as Uint8Array),
      Buffer.from(String(request.expires_at), "utf8")
    ])).digest();
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      challenge: boundChallenge,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: credentials.map(credentialDescriptor)
    });
    this.store.sqlite.prepare("UPDATE auth_enrollment_requests SET approval_challenge = ? WHERE id = ?")
      .run(options.challenge, String(request.id));
    return options;
  }

  async approve(input: { id: string; secret: string; response: AuthenticationResponseJSON }, now = Date.now()): Promise<{ token: string }> {
    const request = this.enrollmentBySecret(input.id, input.secret, "device", now, "awaiting_approval");
    const challenge = text(request.approval_challenge);
    if (!challenge) throw new AuthError(409, "approval_options_required", "请重新开始批准操作");
    this.store.sqlite.prepare("UPDATE auth_enrollment_requests SET approval_challenge = NULL WHERE id = ?").run(String(request.id));
    const credential = this.activeCredentialByWebAuthnId(input.response.id);
    if (!credential) throw new AuthError(401, "credential_untrusted", "此 Passkey 不在可信设备列表中");
    const verification = await this.verifyAuthentication(challenge, input.response, credential);
    this.updateCredentialAfterAuthentication(credential, verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialBackedUp, now);
    const result = this.store.sqlite.prepare(`
      UPDATE auth_enrollment_requests SET status = 'approved', approved_by = ?, approved_at = ?
      WHERE id = ? AND status = 'awaiting_approval'
    `).run(String(credential.id), now, String(request.id));
    if (!Number(result.changes)) throw new AuthError(409, "enrollment_already_used", "此配对请求已经处理");
    return { token: this.issueSession(String(credential.id), now) };
  }

  enrollmentStatus(id: string, tabSecret: string, now = Date.now()):
    { state: "pending"; expiresAt: number } | { state: "authenticated"; token: string } {
    const request = this.enrollmentByTabSecret(id, tabSecret, now);
    if (request.status !== "approved") return { state: "pending", expiresAt: Number(request.expires_at) };
    const credentialRowId = randomUUID();
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.store.sqlite.prepare("SELECT * FROM auth_enrollment_requests WHERE id = ?").get(id) as Row;
      if (current.status !== "approved") throw new AuthError(409, "enrollment_already_used", "此配对请求已经兑换");
      this.insertPendingCredential(credentialRowId, current, now);
      this.store.sqlite.prepare("UPDATE auth_enrollment_requests SET status = 'redeemed', consumed_at = ? WHERE id = ?")
        .run(now, id);
      const token = this.issueSession(credentialRowId, now);
      this.store.sqlite.exec("COMMIT");
      return { state: "authenticated", token };
    } catch (error) {
      this.store.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async loginOptions(now = Date.now()): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const credentials = this.activeCredentialRows();
    if (!credentials.length) throw new AuthError(409, "bootstrap_required", "请先用终端二维码注册首台可信设备");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: 60_000,
      userVerification: "required",
      allowCredentials: credentials.map(credentialDescriptor)
    });
    const challengeId = randomUUID();
    this.store.sqlite.prepare(`
      INSERT INTO auth_challenges (id, kind, challenge, created_at, expires_at) VALUES (?, 'login', ?, ?, ?)
    `).run(challengeId, options.challenge, now, now + CHALLENGE_TTL_MS);
    this.store.sqlite.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").run(now);
    return { challengeId, options };
  }

  async login(input: { challengeId: string; response: AuthenticationResponseJSON }, now = Date.now()): Promise<{ token: string }> {
    const challenge = this.store.sqlite.prepare(`
      SELECT * FROM auth_challenges WHERE id = ? AND kind = 'login' AND expires_at > ?
    `).get(input.challengeId, now) as Row | undefined;
    if (!challenge) throw new AuthError(401, "challenge_expired", "登录请求已过期，请重试");
    this.store.sqlite.prepare("DELETE FROM auth_challenges WHERE id = ?").run(input.challengeId);
    const credential = this.activeCredentialByWebAuthnId(input.response.id);
    if (!credential) throw new AuthError(401, "credential_untrusted", "此 Passkey 已撤销或不受信任");
    const verification = await this.verifyAuthentication(String(challenge.challenge), input.response, credential);
    this.updateCredentialAfterAuthentication(credential, verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialBackedUp, now);
    return { token: this.issueSession(String(credential.id), now) };
  }

  authenticate(token: string | undefined, now = Date.now()): AuthIdentity | null {
    if (!token) return null;
    const row = this.store.sqlite.prepare(`
      SELECT s.id AS session_id, s.expires_at, s.last_used_at AS session_last_used,
        c.id AS credential_row_id, c.name
      FROM auth_sessions s JOIN auth_credentials c ON c.id = s.credential_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND c.revoked_at IS NULL
    `).get(secretHash(token), now) as Row | undefined;
    if (!row) return null;
    let expiresAt = Number(row.expires_at);
    let refreshCookie = false;
    if (now - Number(row.session_last_used) >= SESSION_TOUCH_INTERVAL_MS) {
      expiresAt = now + SESSION_TTL_MS;
      refreshCookie = true;
      this.store.sqlite.prepare("UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
        .run(now, expiresAt, String(row.session_id));
      this.store.sqlite.prepare("UPDATE auth_credentials SET last_used_at = ? WHERE id = ?")
        .run(now, String(row.credential_row_id));
    }
    return {
      sessionId: String(row.session_id), credentialId: String(row.credential_row_id), name: String(row.name),
      expiresAt, refreshCookie
    };
  }

  listDevices(currentCredentialId: string): AuthDeviceDto[] {
    return (this.store.sqlite.prepare(`
      SELECT c.*, issuer.name AS approved_by_name FROM auth_credentials c
      LEFT JOIN auth_credentials issuer ON issuer.id = c.approved_by
      WHERE c.revoked_at IS NULL ORDER BY c.last_used_at DESC
    `).all() as Row[]).map((row) => ({
      id: String(row.id), name: String(row.name), current: String(row.id) === currentCredentialId,
      backupEligible: row.device_type === "multiDevice", backedUp: Boolean(row.backed_up),
      approvedByName: text(row.approved_by_name), createdAt: Number(row.created_at), lastUsedAt: Number(row.last_used_at)
    }));
  }

  revokeDevice(id: string, now = Date.now()): boolean {
    this.store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.store.sqlite.prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, id);
      if (Number(result.changes)) {
        this.store.sqlite.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL")
          .run(now, id);
      }
      this.store.sqlite.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.store.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  logout(token: string | undefined, now = Date.now()): void {
    if (token) this.store.sqlite.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(now, secretHash(token));
  }

  private async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const owner = this.store.sqlite.prepare("SELECT user_handle FROM auth_owner WHERE id = 1").get() as Row;
    return generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: Buffer.from(String(owner.user_handle), "hex"),
      userName: "owner",
      userDisplayName: "llm-chat owner",
      timeout: 60_000,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: this.activeCredentialRows().map(credentialDescriptor)
    });
  }

  private async verifyRegistration(request: Row, response: RegistrationResponseJSON) {
    const challenge = text(request.registration_challenge);
    if (!challenge) throw new AuthError(409, "registration_options_required", "请重新开始 Passkey 注册");
    try {
      const result = await verifyRegistrationResponse({
        response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpId,
        requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257]
      });
      if (!result.verified || !result.registrationInfo) throw new Error("verification failed");
      return result.registrationInfo;
    } catch {
      throw new AuthError(401, "passkey_registration_failed", "无法验证 Passkey，请重新开始");
    }
  }

  private async verifyAuthentication(challenge: string, response: AuthenticationResponseJSON, row: Row) {
    try {
      const result = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpId,
        credential: webAuthnCredential(row), requireUserVerification: true
      });
      if (!result.verified) throw new Error("verification failed");
      return result;
    } catch {
      throw new AuthError(401, "passkey_verification_failed", "无法验证 Passkey，请重试");
    }
  }

  private enrollmentBySecret(id: string, secret: string, kind: "bootstrap" | "device", now: number, status = "created"): Row {
    const row = this.store.sqlite.prepare(`
      SELECT * FROM auth_enrollment_requests
      WHERE id = ? AND kind = ? AND approval_secret_hash = ? AND status = ? AND expires_at > ?
    `).get(id, kind, secretHash(secret), status, now) as Row | undefined;
    if (!row) throw new AuthError(401, "enrollment_invalid", "二维码无效、已使用或已过期");
    return row;
  }

  private enrollmentByTabSecret(id: string, secret: string, now: number, status?: string): Row {
    const row = this.store.sqlite.prepare(`
      SELECT * FROM auth_enrollment_requests WHERE id = ? AND tab_secret_hash = ? AND expires_at > ?
    `).get(id, secretHash(secret), now) as Row | undefined;
    if (!row || (status && row.status !== status) || row.status === "expired" || row.status === "redeemed") {
      throw new AuthError(401, "enrollment_invalid", "配对请求无效、已使用或已过期");
    }
    return row;
  }

  private activeCredentialRows(): Row[] {
    return this.store.sqlite.prepare("SELECT * FROM auth_credentials WHERE revoked_at IS NULL ORDER BY created_at").all() as Row[];
  }

  private activeCredentialCount(): number {
    return Number((this.store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE revoked_at IS NULL").get() as Row).count);
  }

  private activeCredentialByWebAuthnId(credentialId: string): Row | undefined {
    return this.store.sqlite.prepare("SELECT * FROM auth_credentials WHERE credential_id = ? AND revoked_at IS NULL")
      .get(credentialId) as Row | undefined;
  }

  private insertCredential(id: string, name: string, approvedBy: string | null,
    info: Awaited<ReturnType<AuthManager["verifyRegistration"]>>, response: RegistrationResponseJSON, now: number): void {
    this.store.sqlite.prepare(`
      INSERT INTO auth_credentials (
        id, credential_id, public_key, counter, transports_json, device_type,
        backed_up, name, approved_by, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter,
      JSON.stringify(response.response.transports ?? []), info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0, name, approvedBy, now, now);
  }

  private insertPendingCredential(id: string, request: Row, now: number): void {
    this.store.sqlite.prepare(`
      INSERT INTO auth_credentials (
        id, credential_id, public_key, counter, transports_json, device_type,
        backed_up, name, approved_by, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(request.pending_credential_id), request.pending_public_key as Uint8Array,
      Number(request.pending_counter), String(request.pending_transports_json), String(request.pending_device_type),
      Number(request.pending_backed_up), String(request.device_name), text(request.approved_by), now, now);
  }

  private issueSession(credentialId: string, now: number): string {
    const token = randomSecret();
    this.store.sqlite.prepare(`
      INSERT INTO auth_sessions (id, credential_id, token_hash, created_at, last_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), credentialId, secretHash(token), now, now, now + SESSION_TTL_MS);
    return token;
  }

  private updateCredentialAfterAuthentication(row: Row, counter: number, backedUp: boolean, now: number): void {
    this.store.sqlite.prepare("UPDATE auth_credentials SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?")
      .run(counter, backedUp ? 1 : 0, now, String(row.id));
  }
}

function credentialDescriptor(row: Row): { id: string; transports: AuthenticatorTransportFuture[] } {
  return { id: String(row.credential_id), transports: parseTransports(row.transports_json) };
}

function webAuthnCredential(row: Row): WebAuthnCredential {
  return {
    id: String(row.credential_id), publicKey: new Uint8Array(row.public_key as Uint8Array),
    counter: Number(row.counter), transports: parseTransports(row.transports_json)
  };
}

function parseTransports(value: unknown): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed as AuthenticatorTransportFuture[] : [];
  } catch {
    return [];
  }
}

function cleanName(value: string): string { return value.trim().slice(0, 80) || "未命名设备"; }
function randomSecret(): string { return randomBytes(32).toString("base64url"); }
function secretHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function text(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }

export function describeBrowser(userAgent: string): string {
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/Edg\//i.test(userAgent)) return "Edge";
  if (/CriOS\//i.test(userAgent)) return "Chrome iOS";
  if (/FxiOS\//i.test(userAgent)) return "Firefox iOS";
  if (/Chrome\//i.test(userAgent)) return "Chrome";
  if (/Safari\//i.test(userAgent)) return "Safari";
  return "未知浏览器";
}
