import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, AuthManager, describeBrowser } from "./auth";
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
