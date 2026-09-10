import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationNotificationState } from "@llm-chat/contracts";
import { createNotificationWorker, requestNotificationPath } from "./notification-worker";
import { claimNotification, readNotificationControl } from "./notification-db";
import { generationNotices } from "./notification-protocol";

vi.mock("./notification-db", () => ({ claimNotification: vi.fn(), readNotificationControl: vi.fn() }));
const state: GenerationNotificationState = { generationId: "g", messageId: "m", conversationId: "c", conversationTitle: "测试会话", status: "completed", stopReason: null, pendingTools: [] };
const control = { enabled: true, authorized: true, revision: "1" };
const candidate = (notify = true) => ({ kind: "generation" as const, sourceId: "server", state, notify, revision: "1" });
const windowClient = (patch = {}) => ({ id: "tab", type: "window", frameType: "top-level", url: "https://chat.test/settings/general", focused: true,
  visibilityState: "visible", focus: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn(), ...patch }) as unknown as WindowClient;
function setup() {
  let clients: WindowClient[] = [windowClient()];
  const displayed: Notification[] = [];
  const env = { origin: "https://chat.test", currentPath: vi.fn(async (client: WindowClient) => new URL(client.url).pathname), clients: {
    get: vi.fn(async (id: string) => clients.find((client) => client.id === id)),
    matchAll: vi.fn(async () => clients), openWindow: vi.fn().mockResolvedValue(null)
  }, registration: {
    getNotifications: vi.fn(async () => displayed), showNotification: vi.fn().mockResolvedValue(undefined)
  } };
  return { env, worker: createNotificationWorker(env), displayed, clients: () => clients, setClients: (value: WindowClient[]) => { clients = value; } };
}
beforeEach(() => {
  vi.mocked(readNotificationControl).mockReset().mockResolvedValue(control);
  const seen = new Set<string>();
  vi.mocked(claimNotification).mockReset().mockImplementation(async (key) => { if (seen.has(key)) return false; seen.add(key); return true; });
});

describe("system notification delivery", () => {
  it("serializes simultaneous tabs and displays a notification while viewing settings", async () => {
    const { worker, env } = setup();
    await Promise.all([worker.handle(candidate(), "tab"), worker.handle(candidate(), "tab")]);
    expect(env.registration.showNotification).toHaveBeenCalledExactlyOnceWith("回复已完成", expect.objectContaining({ body: "测试会话", tag: "llm-chat:server:g:terminal" }));
  });

  it("suppresses and remembers events if any focused tab is viewing the exact chat", async () => {
    const test = setup(); test.setClients([windowClient(), windowClient({ id: "other", url: "https://chat.test/c/c" })]);
    await test.worker.handle(candidate(), "tab");
    test.setClients([windowClient()]);
    await test.worker.handle(candidate(), "tab");
    expect(test.env.registration.showNotification).not.toHaveBeenCalled();
  });

  it("uses the current SPA route instead of the client's stale document URL", async () => {
    const test = setup(); test.env.currentPath.mockResolvedValue("/c/c/");
    await test.worker.handle(candidate(), "tab");
    expect(test.env.registration.showNotification).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://chat.test/c/c", focused: false },
    { url: "https://chat.test/c/c", visibilityState: "hidden" },
    { url: "https://chat.test/c/different" },
    { url: "https://chat.test/c/c/tasks" }
  ])("notifies when the target chat is not foreground: %j", async (patch) => {
    const test = setup(); test.setClients([windowClient(patch)]);
    await test.worker.handle(candidate(), "tab");
    expect(test.env.registration.showNotification).toHaveBeenCalledOnce();
  });

  it.each([{ enabled: false }, { authorized: false }])("closes existing app notifications when disabled: %j", async (patch) => {
    const { worker, displayed } = setup(); const close = vi.fn(); const foreign = vi.fn();
    displayed.push({ tag: "llm-chat:old", close } as unknown as Notification, { tag: "foreign", close: foreign } as unknown as Notification);
    vi.mocked(readNotificationControl).mockResolvedValue({ ...control, ...patch });
    await worker.handle(candidate(), "tab");
    expect(close).toHaveBeenCalledOnce(); expect(foreign).not.toHaveBeenCalled();
  });

  it("does not display baselines, stale revisions, or messages from missing/embedded/foreign clients", async () => {
    const test = setup();
    await test.worker.handle({ kind: "sync" }, "tab");
    await test.worker.handle(candidate(false), "tab");
    await test.worker.handle({ ...candidate(), revision: "old" }, "tab");
    await test.worker.handle(candidate(), "missing");
    for (const patch of [{ frameType: "nested" }, { type: "worker" }, { url: "https://other.test/" }]) {
      test.setClients([windowClient(patch)]); await test.worker.handle(candidate(), "tab");
    }
    expect(test.env.registration.showNotification).not.toHaveBeenCalled();
  });

  it("rechecks preferences and the sender immediately before displaying", async () => {
    const test = setup();
    vi.mocked(readNotificationControl).mockResolvedValueOnce(control).mockResolvedValue({ ...control, enabled: false });
    await test.worker.handle(candidate(), "tab");
    expect(test.env.registration.showNotification).not.toHaveBeenCalled();
  });

  it("closes resolved approvals, deleted conversations and foreground conversations", async () => {
    const test = setup(); const approval = generationNotices("server", { ...state, status: "waiting-approval", pendingTools: [{ id: "t", name: "tool", stepIndex: 0 }] })[0]!;
    const close = vi.fn(); test.displayed.push({ tag: "llm-chat:" + approval.key, data: approval, close } as unknown as Notification);
    await test.worker.handle(candidate(false), "tab"); expect(close).toHaveBeenCalledOnce();
    await test.worker.handle({ kind: "clear-conversations", ids: ["c"] }, "tab"); expect(close).toHaveBeenCalledTimes(2);
    test.setClients([windowClient({ url: "https://chat.test/c/c" })]);
    await test.worker.handle({ kind: "foreground" }, "tab"); expect(close).toHaveBeenCalledTimes(3);
  });

  it("does not close a still-pending batch and recovers after display failures", async () => {
    const test = setup(); const pending = { ...state, status: "waiting-approval" as const, pendingTools: [{ id: "t", name: "tool", stepIndex: 0 }] };
    const notice = generationNotices("server", pending)[0]!; const close = vi.fn();
    test.displayed.push({ tag: "llm-chat:" + notice.key, data: notice, close } as unknown as Notification);
    await test.worker.handle({ ...candidate(false), state: pending }, "tab"); expect(close).not.toHaveBeenCalled();
    test.env.registration.showNotification.mockRejectedValueOnce(new Error("denied"));
    await expect(test.worker.handle(candidate(), "tab")).rejects.toThrow("denied");
    await test.worker.handle({ ...candidate(), state: { ...state, generationId: "next" } }, "tab");
    expect(test.env.registration.showNotification).toHaveBeenCalledTimes(2);
  });

  it("opens notifications through the SPA, preferring the existing target tab", async () => {
    const test = setup(); const target = windowClient({ id: "target", url: "https://chat.test/c/c" });
    test.setClients([windowClient(), target, windowClient({ id: "foreign", url: "https://foreign.test/c/c" })]);
    const notice = generationNotices("server", state)[0]!;
    await test.worker.click(notice);
    expect(target.focus).toHaveBeenCalledOnce();
    expect(target.postMessage).toHaveBeenCalledWith({ type: "CHAT_NOTIFICATION_OPEN", path: "/c/c" });
    test.setClients([windowClient()]); await test.worker.click(notice);
    expect(test.clients()[0]?.focus).toHaveBeenCalledOnce();
    test.setClients([]); await test.worker.click(notice);
    expect(test.env.clients.openWindow).toHaveBeenCalledWith("https://chat.test/c/c");
    await test.worker.click(null!);
    await test.worker.click({ ...notice, conversationId: null! });
    expect(test.env.clients.openWindow).toHaveBeenCalledOnce();
  });
});

it("queries the page's current route and bounds missing or failed responses", async () => {
  vi.useFakeTimers();
  let response: ((event: MessageEvent) => void) | null = null;
  vi.stubGlobal("MessageChannel", class {
    port1 = { set onmessage(value: (event: MessageEvent) => void) { response = value; }, close: vi.fn() };
    port2 = { close: vi.fn() };
  });
  try {
    const client = windowClient();
    const route = requestNotificationPath(client);
    response!({ data: { path: "/c/current" } } as MessageEvent);
    expect(await route).toBe("/c/current");
    const invalid = requestNotificationPath(client); response!({ data: {} } as MessageEvent);
    expect(await invalid).toBeNull();
    const missing = requestNotificationPath(client); await vi.advanceTimersByTimeAsync(501);
    expect(await missing).toBeNull();
    vi.mocked(client.postMessage).mockImplementationOnce(() => { throw new Error("closed"); });
    expect(await requestNotificationPath(client)).toBeNull();
  } finally { vi.useRealTimers(); }
});
