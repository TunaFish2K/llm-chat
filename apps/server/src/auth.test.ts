import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, AuthManager, describeBrowser, resetAuthentication } from "./auth";
import { Store } from "./database";

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(async () => ({
    challenge: "registration-challenge",
    rp: { id: "localhost", name: "llm-chat" },
    user: { id: "owner", name: "owner", displayName: "owner" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }]
  })),
  verifyRegistrationResponse: vi.fn(async ({ response }: { response: RegistrationResponseJSON }) => ({
    verified: true,
    registrationInfo: {
      credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialDeviceType: response.id === "credential-one" ? "singleDevice" : "multiDevice",
      credentialBackedUp: response.id !== "credential-one",
      origin: "http://localhost:3000",
      rpID: "localhost"
    }
  })),
  generateAuthenticationOptions: vi.fn(async ({ challenge }: { challenge?: Uint8Array }) => ({
    challenge: challenge ? Buffer.from(challenge).toString("base64url") : "authentication-challenge",
    rpId: "localhost",
    allowCredentials: []
  })),
  verifyAuthenticationResponse: vi.fn(async ({ response }: { response: AuthenticationResponseJSON }) => ({
    verified: true,
    authenticationInfo: { newCounter: 1, credentialBackedUp: response.id !== "credential-one" }
  }))
}));

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WebAuthn device trust", () => {
  it("describes common approval browsers without treating the user agent as identity", () => {
    expect([
      describeBrowser("Firefox/142"),
      describeBrowser("Edg/140"),
      describeBrowser("CriOS/140"),
      describeBrowser("FxiOS/142"),
      describeBrowser("Chrome/140"),
      describeBrowser("Version/18 Safari/605"),
      describeBrowser("custom-client")
    ]).toEqual(["Firefox", "Edge", "Chrome iOS", "Firefox iOS", "Chrome", "Safari", "未知浏览器"]);
  });

  it("bootstraps once, approves a new credential, and keeps it trusted when its issuer is revoked", async () => {
    const messages: string[] = [];
    const { auth, store } = createAuth(messages);
    const bootstrapUrl = await auth.ensureBootstrapRequest(1_000);
    expect(auth.authenticate(undefined, 1_000)).toBeNull();
    await expect(auth.loginOptions(1_000)).rejects.toMatchObject({ code: "bootstrap_required" });
    expect(bootstrapUrl).toContain("/pair#mode=bootstrap");
    expect(await auth.ensureBootstrapRequest(1_001)).toBe(bootstrapUrl);
    expect(messages).toHaveLength(1);
    const bootstrap = pairParts(bootstrapUrl!);

    await auth.bootstrapOptions(bootstrap.requestId, bootstrap.secret, 1_500);
    const first = await auth.verifyBootstrap({
      id: bootstrap.requestId,
      secret: bootstrap.secret,
      deviceName: "可信手机",
      response: registration("credential-one", false)
    }, 2_000);
    const firstIdentity = auth.authenticate(first.token, 2_001);
    expect(firstIdentity).toMatchObject({ name: "可信手机" });
    expect(await auth.ensureBootstrapRequest(2_002)).toBeNull();
    await expect(auth.bootstrapOptions(bootstrap.requestId, bootstrap.secret, 2_002))
      .rejects.toMatchObject({ code: "bootstrap_complete" });
    await expect(auth.verifyBootstrap({
      id: bootstrap.requestId, secret: bootstrap.secret, deviceName: "重复", response: registration("duplicate-bootstrap")
    }, 2_002)).rejects.toMatchObject({ code: "bootstrap_complete" });

    const started = await auth.beginEnrollment({ deviceName: "工作电脑", ip: "192.0.2.5", userAgent: "Mozilla/5.0 Firefox/142" }, 3_000);
    expect(auth.enrollmentStatus(started.id, started.tabSecret, 3_001)).toMatchObject({ state: "pending" });
    await expect(auth.finishEnrollment({
      id: started.id,
      tabSecret: started.tabSecret,
      approvalSecret: "incorrect-approval-secret",
      response: registration("credential-two")
    }, 3_001)).rejects.toMatchObject({ code: "enrollment_invalid" });
    const finished = await auth.finishEnrollment({
      id: started.id,
      tabSecret: started.tabSecret,
      approvalSecret: started.approvalSecret,
      response: registration("credential-two")
    }, 3_001);
    expect(finished.approvalQr).toMatch(/^data:image\/png;base64,/);
    expect(auth.approvalDetails(started.id, started.approvalSecret, 3_002)).toMatchObject({
      deviceName: "工作电脑", browser: "Firefox", ip: "192.0.2.5"
    });
    store.sqlite.prepare("UPDATE auth_enrollment_requests SET request_ip = NULL, user_agent = NULL WHERE id = ?").run(started.id);
    expect(auth.approvalDetails(started.id, started.approvalSecret, 3_002)).toMatchObject({ browser: "未知浏览器", ip: "未知" });
    expect(() => auth.approvalDetails(started.id, "wrong-approval-secret", 3_002)).toThrow(AuthError);
    await expect(auth.approve({
      id: started.id,
      secret: started.approvalSecret,
      response: authentication("credential-one")
    }, 3_002)).rejects.toMatchObject({ code: "approval_options_required" });
    await auth.approvalOptions(started.id, started.approvalSecret, 3_003);
    await expect(auth.approve({
      id: started.id,
      secret: started.approvalSecret,
      response: authentication("untrusted")
    }, 3_004)).rejects.toMatchObject({ code: "credential_untrusted" });
    await auth.approvalOptions(started.id, started.approvalSecret, 3_005);
    await auth.approve({
      id: started.id,
      secret: started.approvalSecret,
      response: authentication("credential-one")
    }, 3_006);
    const redeemed = auth.enrollmentStatus(started.id, started.tabSecret, 3_007);
    expect(redeemed.state).toBe("authenticated");
    const secondToken = redeemed.state === "authenticated" ? redeemed.token : "";
    expect(() => auth.enrollmentStatus(started.id, started.tabSecret, 3_008)).toThrow(AuthError);
    const devices = auth.listDevices(firstIdentity!.credentialId);
    expect(devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "可信手机", current: true }),
      expect.objectContaining({ name: "工作电脑", current: false, backedUp: true, approvedByName: "可信手机" })
    ]));

    const untrustedOptions = await auth.loginOptions(3_099);
    await expect(auth.login({ challengeId: untrustedOptions.challengeId, response: authentication("untrusted") }, 3_100))
      .rejects.toMatchObject({ code: "credential_untrusted" });
    const loginOptions = await auth.loginOptions(3_100);
    await expect(auth.login({ challengeId: "missing", response: authentication("credential-two") }, 3_100))
      .rejects.toMatchObject({ code: "challenge_expired" });
    const loggedIn = await auth.login({ challengeId: loginOptions.challengeId, response: authentication("credential-two") }, 3_101);
    const touchedAt = 3_101 + 24 * 60 * 60 * 1000 + 1;
    expect(auth.authenticate(loggedIn.token, touchedAt)).toMatchObject({ name: "工作电脑", refreshCookie: true });
    auth.logout(loggedIn.token, touchedAt + 1);
    auth.logout(undefined, touchedAt + 1);
    expect(auth.authenticate(loggedIn.token, touchedAt + 2)).toBeNull();
    expect(auth.revokeDevice("missing", 3_500)).toBe(false);

    const duplicate = await auth.beginEnrollment({ deviceName: "重复设备", ip: "", userAgent: "Chrome/140" }, 3_550);
    await expect(auth.finishEnrollment({
      id: duplicate.id, tabSecret: duplicate.tabSecret, approvalSecret: duplicate.approvalSecret,
      response: registration("credential-two")
    }, 3_551)).rejects.toMatchObject({ code: "credential_exists" });
    const unnamed = await auth.beginEnrollment({ deviceName: "   ", ip: "", userAgent: "Safari/605" }, 3_560);
    expect((store.sqlite.prepare("SELECT device_name FROM auth_enrollment_requests WHERE id = ?").get(unnamed.id) as { device_name: string }).device_name)
      .toBe("未命名设备");
    const missingChallenge = await auth.beginEnrollment({ deviceName: "无挑战", ip: "", userAgent: "" }, 3_570);
    store.sqlite.prepare("UPDATE auth_enrollment_requests SET registration_challenge = NULL WHERE id = ?").run(missingChallenge.id);
    await expect(auth.finishEnrollment({
      id: missingChallenge.id, tabSecret: missingChallenge.tabSecret, approvalSecret: missingChallenge.approvalSecret,
      response: registration("missing-challenge")
    }, 3_571)).rejects.toMatchObject({ code: "registration_options_required" });

    store.sqlite.prepare("UPDATE auth_credentials SET transports_json = '{}' WHERE credential_id = ?")
      .run("credential-two");
    await expect(auth.loginOptions(3_590)).resolves.toMatchObject({ options: expect.any(Object) });
    store.sqlite.prepare("UPDATE auth_credentials SET transports_json = 'not-json' WHERE credential_id = ?")
      .run("credential-two");
    await expect(auth.loginOptions(3_600)).resolves.toMatchObject({ options: expect.any(Object) });

    expect(auth.revokeDevice(firstIdentity!.credentialId, 4_000)).toBe(true);
    expect(auth.authenticate(first.token, 4_001)).toBeNull();
    expect(auth.authenticate(secondToken, 4_001)).toMatchObject({ name: "工作电脑" });
    expect(auth.listDevices("none")).toEqual([expect.objectContaining({ name: "工作电脑" })]);

    const requestRow = store.sqlite.prepare("SELECT * FROM auth_enrollment_requests WHERE id = ?").get(started.id) as Record<string, unknown>;
    expect(requestRow.tab_secret_hash).not.toBe(started.tabSecret);
    expect(requestRow.approval_secret_hash).not.toBe(started.approvalSecret);
  });

  it("rejects expired or incorrect QR secrets without disclosing request state", async () => {
    const { auth } = createAuth([]);
    await expect(auth.beginEnrollment({ deviceName: "未授权电脑", ip: "", userAgent: "" }, 9_999))
      .rejects.toMatchObject({ code: "bootstrap_required" });
    const url = await auth.ensureBootstrapRequest(10_000);
    const bootstrap = pairParts(url!);
    await expect(auth.bootstrapOptions(bootstrap.requestId, "wrong-secret-that-is-long-enough", 10_001))
      .rejects.toBeInstanceOf(AuthError);
    await expect(auth.bootstrapOptions(bootstrap.requestId, bootstrap.secret, 10_001))
      .resolves.toMatchObject({ challenge: "registration-challenge" });
    await expect(auth.verifyBootstrap({
      id: bootstrap.requestId,
      secret: bootstrap.secret,
      deviceName: "过期设备",
      response: registration("expired")
    }, 10_000 + 10 * 60 * 1000 + 1)).rejects.toMatchObject({ code: "enrollment_invalid" });
  });

  it("atomically resets every active authentication path and permits a fresh bootstrap", async () => {
    const resetAt = 30_000;
    const { auth, store } = createAuth([]);
    const bootstrapUrl = await auth.ensureBootstrapRequest(20_000);
    const bootstrap = pairParts(bootstrapUrl!);
    await auth.bootstrapOptions(bootstrap.requestId, bootstrap.secret, 20_001);
    const first = await auth.verifyBootstrap({
      id: bootstrap.requestId,
      secret: bootstrap.secret,
      deviceName: "旧手机",
      response: registration("credential-one")
    }, 20_002);

    const created = await auth.beginEnrollment({ deviceName: "尚未注册", ip: "", userAgent: "" }, 20_003);
    const awaiting = await auth.beginEnrollment({ deviceName: "等待批准", ip: "", userAgent: "" }, 20_004);
    await auth.finishEnrollment({
      id: awaiting.id,
      tabSecret: awaiting.tabSecret,
      approvalSecret: awaiting.approvalSecret,
      response: registration("credential-awaiting")
    }, 20_005);

    const approved = await auth.beginEnrollment({ deviceName: "已经批准", ip: "", userAgent: "" }, 20_006);
    await auth.finishEnrollment({
      id: approved.id,
      tabSecret: approved.tabSecret,
      approvalSecret: approved.approvalSecret,
      response: registration("credential-approved")
    }, 20_007);
    await auth.approvalOptions(approved.id, approved.approvalSecret, 20_008);
    await auth.approve({
      id: approved.id,
      secret: approved.approvalSecret,
      response: authentication("credential-one")
    }, 20_009);

    const redeemed = await auth.beginEnrollment({ deviceName: "已兑换设备", ip: "", userAgent: "" }, 20_010);
    await auth.finishEnrollment({
      id: redeemed.id,
      tabSecret: redeemed.tabSecret,
      approvalSecret: redeemed.approvalSecret,
      response: registration("credential-redeemed")
    }, 20_011);
    await auth.approvalOptions(redeemed.id, redeemed.approvalSecret, 20_012);
    await auth.approve({
      id: redeemed.id,
      secret: redeemed.approvalSecret,
      response: authentication("credential-one")
    }, 20_013);
    const redeemedResult = auth.enrollmentStatus(redeemed.id, redeemed.tabSecret, 20_014);
    const secondToken = redeemedResult.state === "authenticated" ? redeemedResult.token : "";
    const login = await auth.loginOptions(20_015);
    store.sqlite.prepare(`
      INSERT INTO auth_enrollment_requests
        (id, kind, status, device_name, approval_secret_hash, created_at, expires_at)
      VALUES ('already-expired', 'device', 'expired', '过期请求', 'hash', ?, ?)
    `).run(19_000, resetAt - 1);

    const ownerBefore = store.sqlite.prepare("SELECT user_handle FROM auth_owner WHERE id = 1").get();
    expect(resetAuthentication(store, resetAt)).toEqual({
      credentialsRevoked: 2,
      sessionsRevoked: 4,
      enrollmentsExpired: 3,
      challengesDeleted: 1
    });

    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_credentials").get()).toEqual({ count: 2 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 4 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_enrollment_requests").get()).toEqual({ count: 6 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE revoked_at = ?").get(resetAt))
      .toEqual({ count: 2 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at = ?").get(resetAt))
      .toEqual({ count: 4 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_challenges").get()).toEqual({ count: 0 });
    expect(store.sqlite.prepare("SELECT user_handle FROM auth_owner WHERE id = 1").get()).toEqual(ownerBefore);
    expect(store.sqlite.prepare(`
      SELECT id, status, expires_at, consumed_at FROM auth_enrollment_requests
      WHERE id IN (?, ?, ?) ORDER BY id
    `).all(created.id, awaiting.id, approved.id)).toEqual([
      { id: approved.id, status: "expired", expires_at: resetAt, consumed_at: null },
      { id: awaiting.id, status: "expired", expires_at: resetAt, consumed_at: null },
      { id: created.id, status: "expired", expires_at: resetAt, consumed_at: null }
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(store.sqlite.prepare(`
      SELECT status, consumed_at FROM auth_enrollment_requests WHERE id = ?
    `).get(redeemed.id)).toEqual({ status: "redeemed", consumed_at: 20_014 });
    expect(store.sqlite.prepare(`
      SELECT status, expires_at FROM auth_enrollment_requests WHERE id = 'already-expired'
    `).get()).toEqual({ status: "expired", expires_at: resetAt - 1 });

    const stateAfterReset = store.sqlite.prepare(`
      SELECT id, status, expires_at, consumed_at FROM auth_enrollment_requests ORDER BY id
    `).all();
    expect(resetAuthentication(store, resetAt + 1)).toEqual({
      credentialsRevoked: 0,
      sessionsRevoked: 0,
      enrollmentsExpired: 0,
      challengesDeleted: 0
    });
    expect(store.sqlite.prepare(`
      SELECT id, status, expires_at, consumed_at FROM auth_enrollment_requests ORDER BY id
    `).all()).toEqual(stateAfterReset);

    expect(auth.authenticate(first.token, resetAt + 2)).toBeNull();
    expect(auth.authenticate(secondToken, resetAt + 2)).toBeNull();
    expect(auth.listDevices("none")).toEqual([]);
    await expect(auth.loginOptions(resetAt + 2)).rejects.toMatchObject({ code: "bootstrap_required" });
    expect(() => auth.enrollmentStatus(created.id, created.tabSecret, resetAt + 2)).toThrow(AuthError);
    expect(() => auth.approvalDetails(awaiting.id, awaiting.approvalSecret, resetAt + 2)).toThrow(AuthError);
    expect(() => auth.enrollmentStatus(approved.id, approved.tabSecret, resetAt + 2)).toThrow(AuthError);
    await expect(auth.login({ challengeId: login.challengeId, response: authentication("credential-one") }, resetAt + 2))
      .rejects.toMatchObject({ code: "challenge_expired" });

    const announcements: string[] = [];
    const freshAuth = new AuthManager(
      store,
      { origin: "http://localhost:3000", rpId: "localhost" },
      (message) => announcements.push(message)
    );
    const freshBootstrapUrl = await freshAuth.ensureBootstrapRequest(resetAt + 2);
    expect(freshBootstrapUrl).toContain("/pair#mode=bootstrap");
    expect(freshBootstrapUrl).not.toBe(bootstrapUrl);
    expect(announcements).toHaveLength(1);
  });

  it("rolls back every reset mutation when one statement fails", async () => {
    const { auth, store } = createAuth([]);
    const bootstrapUrl = await auth.ensureBootstrapRequest(40_000);
    const bootstrap = pairParts(bootstrapUrl!);
    await auth.bootstrapOptions(bootstrap.requestId, bootstrap.secret, 40_001);
    const first = await auth.verifyBootstrap({
      id: bootstrap.requestId,
      secret: bootstrap.secret,
      deviceName: "仍然可信",
      response: registration("credential-one")
    }, 40_002);
    await auth.beginEnrollment({ deviceName: "保留配对", ip: "", userAgent: "" }, 40_003);
    await auth.loginOptions(40_004);
    store.sqlite.exec(`
      CREATE TRIGGER fail_auth_session_reset
      BEFORE UPDATE OF revoked_at ON auth_sessions
      WHEN OLD.revoked_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced reset failure');
      END
    `);

    expect(() => resetAuthentication(store, 50_000)).toThrow("forced reset failure");
    expect(store.sqlite.prepare("SELECT revoked_at FROM auth_credentials").get()).toEqual({ revoked_at: null });
    expect(store.sqlite.prepare("SELECT revoked_at FROM auth_sessions").get()).toEqual({ revoked_at: null });
    expect(store.sqlite.prepare("SELECT status FROM auth_enrollment_requests WHERE status = 'created'").get())
      .toEqual({ status: "created" });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_challenges").get()).toEqual({ count: 1 });
    expect(auth.authenticate(first.token, 50_001)).toMatchObject({ name: "仍然可信" });

    store.sqlite.exec("DROP TRIGGER fail_auth_session_reset");
    expect(resetAuthentication(store, 50_002)).toEqual({
      credentialsRevoked: 1,
      sessionsRevoked: 1,
      enrollmentsExpired: 1,
      challengesDeleted: 1
    });
  });
});

function createAuth(messages: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-auth-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.sqlite"));
  stores.push(store);
  return { store, auth: new AuthManager(store, { origin: "http://localhost:3000", rpId: "localhost" }, (message) => messages.push(message)) };
}

function pairParts(url: string) {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.slice(1));
  return { requestId: hash.get("request")!, secret: hash.get("secret")! };
}

function registration(id: string, includeTransports = true): RegistrationResponseJSON {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "client",
      attestationObject: "attestation",
      ...(includeTransports ? { transports: ["internal"] as const } : {})
    }
  };
}

function authentication(id: string): AuthenticationResponseJSON {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "client", authenticatorData: "authenticator", signature: "signature" }
  };
}
