import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthManager, resetPassword } from "./auth";
import { Store } from "./database";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("password authentication", () => {
  it("creates and announces one eight-digit initial password", async () => {
    const { auth, store, messages } = createAuth();
    const password = await auth.ensurePassword(1_000);
    expect(password).toMatch(/^\d{8}$/);
    expect(messages).toEqual([expect.stringContaining(password!)]);
    expect(await auth.ensurePassword(1_001)).toBeNull();

    const restartedMessages: string[] = [];
    const restarted = new AuthManager(store, (message) => restartedMessages.push(message));
    expect(await restarted.ensurePassword(1_002)).toBeNull();
    expect(restartedMessages).toEqual([]);

    const row = store.sqlite.prepare("SELECT salt, password_hash FROM auth_password WHERE id = 1").get() as {
      salt: Uint8Array;
      password_hash: Uint8Array;
    };
    expect(Buffer.from(row.salt).byteLength).toBe(16);
    expect(Buffer.from(row.password_hash).byteLength).toBe(64);
    expect(Buffer.from(row.password_hash).toString("utf8")).not.toContain(password!);
    store.close();
  });

  it("logs in, refreshes a long-lived session, and logs out", async () => {
    const { auth, store } = createAuth();
    const password = await auth.ensurePassword(2_000);
    await expect(auth.login("wrong-password", 2_001)).rejects.toMatchObject({
      statusCode: 401,
      code: "password_invalid"
    });

    const { token } = await auth.login(password!, 2_002);
    const identity = auth.authenticate(token, 2_003);
    expect(identity).toMatchObject({ sessionId: expect.any(String), refreshCookie: false });
    const touched = auth.authenticate(token, 2_003 + 24 * 60 * 60 * 1000);
    expect(touched).toMatchObject({ sessionId: identity!.sessionId, refreshCookie: true });

    auth.logout(token, 2_004 + 24 * 60 * 60 * 1000);
    expect(auth.authenticate(token, 2_005 + 24 * 60 * 60 * 1000)).toBeNull();
    auth.logout(undefined);
    store.close();
  });

  it("changes the password, revokes every old session, and keeps the current browser signed in", async () => {
    const { auth, store } = createAuth();
    const initial = await auth.ensurePassword(3_000);
    const first = await auth.login(initial!, 3_001);
    const second = await auth.login(initial!, 3_002);
    const firstIdentity = auth.authenticate(first.token, 3_003)!;

    const changed = await auth.changePassword(firstIdentity.sessionId, "new-password-123", 3_004);
    expect(changed.sessionsRevoked).toBe(2);
    expect(auth.authenticate(first.token, 3_005)).toBeNull();
    expect(auth.authenticate(second.token, 3_005)).toBeNull();
    expect(auth.authenticate(changed.token, 3_005)).toMatchObject({ refreshCookie: false });
    await expect(auth.login(initial!, 3_006)).rejects.toMatchObject({ code: "password_invalid" });
    await expect(auth.login("new-password-123", 3_006)).resolves.toEqual({ token: expect.any(String) });
    await expect(auth.changePassword(firstIdentity.sessionId, "another-password", 3_007))
      .rejects.toMatchObject({ code: "authentication_required" });
    store.close();
  });

  it("resets the password offline and revokes active sessions", async () => {
    const { auth, store } = createAuth();
    const initial = await auth.ensurePassword(4_000);
    const session = await auth.login(initial!, 4_001);

    const result = await resetPassword(store, 4_002);
    expect(result).toMatchObject({ password: expect.stringMatching(/^\d{8}$/), sessionsRevoked: 1 });
    expect(result.password).not.toBe(initial);
    expect(auth.authenticate(session.token, 4_003)).toBeNull();
    await expect(auth.login(initial!, 4_004)).rejects.toMatchObject({ code: "password_invalid" });
    await expect(auth.login(result.password, 4_004)).resolves.toEqual({ token: expect.any(String) });
    store.close();
  });

  it("rolls back a password change when session revocation fails", async () => {
    const { auth, store } = createAuth();
    const initial = await auth.ensurePassword(5_000);
    const session = await auth.login(initial!, 5_001);
    const identity = auth.authenticate(session.token, 5_002)!;
    store.sqlite.exec(`
      CREATE TRIGGER fail_password_session_revoke
      BEFORE UPDATE OF revoked_at ON auth_password_sessions
      BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;
    `);

    await expect(auth.changePassword(identity.sessionId, "failed-password", 5_003)).rejects.toThrow("forced rollback");
    expect(auth.authenticate(session.token, 5_004)).not.toBeNull();
    await expect(auth.login(initial!, 5_004)).resolves.toEqual({ token: expect.any(String) });
    await expect(auth.login("failed-password", 5_004)).rejects.toMatchObject({ code: "password_invalid" });
    store.close();
  });
});

function createAuth(): { auth: AuthManager; store: Store; messages: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "llm-chat-password-auth-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.sqlite"));
  const messages: string[] = [];
  return { auth: new AuthManager(store, (message) => messages.push(message)), store, messages };
}
