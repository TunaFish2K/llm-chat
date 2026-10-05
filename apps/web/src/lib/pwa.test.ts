import { afterEach, beforeEach, expect, it, vi } from "vitest";

const register = vi.hoisted(() => vi.fn());
vi.mock("virtual:pwa-register", () => ({ registerSW: register }));
type Options = NonNullable<Parameters<typeof import("virtual:pwa-register").registerSW>[0]>;

type ShellReply = { ok: boolean; result?: unknown; error?: string };
// Workers answer shell commands like sw.ts; tests override per command.
let shellReplies: { install: () => ShellReply | undefined; activate: () => ShellReply | undefined };
class Worker extends EventTarget {
  state = "installing";
  postMessage = vi.fn((message: { type: string }, ports?: Array<{ postMessage(data: unknown): void }>) => {
    const reply = message.type === "INSTALL_SHELL" ? shellReplies.install() : message.type === "ACTIVATE_SHELL" ? shellReplies.activate() : undefined;
    if (reply) ports?.[0]?.postMessage(reply);
  });
  change(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}
let container: EventTarget & { controller: Worker | null; register: ReturnType<typeof vi.fn> };
let current: { active: Worker | null; waiting: Worker | null; installing: Worker | null; update: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
let options: Options;
let online: { onLine: boolean; serviceWorker: typeof container };

beforeEach(() => {
  vi.resetModules(); register.mockReset(); vi.useFakeTimers();
  shellReplies = { install: () => ({ ok: true, result: { status: "current", id: "shell" } }), activate: () => ({ ok: true }) };
  vi.stubGlobal("MessageChannel", class {
    port1 = { onmessage: null as null | ((event: { data: unknown }) => void), close: vi.fn() };
    port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() };
  });
  container = Object.assign(new EventTarget(), { controller: new Worker() as Worker | null, register: vi.fn() });
  current = { active: container.controller, waiting: null, installing: null, update: vi.fn() };
  current.update.mockResolvedValue(current);
  online = { onLine: true, serviceWorker: container };
  Object.assign(online, { languages: ["zh-CN"], language: "zh-CN" });
  vi.stubGlobal("navigator", online);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "shell", protocol: 1, entries: [] })));
  reload = vi.fn();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(), setInterval: vi.fn(),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    location: { reload }
  });
  vi.spyOn(document, "addEventListener").mockImplementation(() => {});
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
});
afterEach(() => vi.useRealTimers());

async function boot(registered = true) {
  const pwa = await import("./pwa");
  pwa.initPwa();
  options = register.mock.calls[0]![0] as Options;
  if (registered) options.onRegisteredSW?.("/sw.js", current as unknown as ServiceWorkerRegistration);
  return pwa;
}

it("shares a pending check and lets manual checks bypass the automatic throttle", async () => {
  const pwa = await boot();
  let resolve!: () => void;
  current.update.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  const first = pwa.checkForUpdates();
  expect(pwa.checkForUpdates()).toBe(first);
  await vi.advanceTimersByTimeAsync(0);
  expect(pwa.getPwaState().updateStatus).toBe("checking");
  resolve(); await first;
  expect(pwa.getPwaState().updateStatus).toBe("current");
  await pwa.checkForUpdates();
  expect(current.update).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});

it("waits for installation and only reloads after explicit apply and controller takeover", async () => {
  const pwa = await boot();
  const worker = new Worker();
  current.installing = worker;
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(0);
  expect(pwa.getPwaState().updateStatus).toBe("downloading");
  expect(pwa.getPwaState().updateAvailable).toBe(false);
  current.waiting = worker; current.installing = null;
  worker.change("installed"); await checking;
  expect(pwa.getPwaState().updateStatus).toBe("ready");
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  const applying = pwa.applyUpdate();
  await vi.advanceTimersByTimeAsync(0);
  expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  expect(pwa.getPwaState().updateAvailable).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  await applying;
  options.onNeedReload?.();
  expect(reload).toHaveBeenCalledOnce();
  expect(pwa.getPwaState().updateAvailable).toBe(false);
});

it("reports offline and network errors and allows retry", async () => {
  const pwa = await boot();
  online.onLine = false;
  current.update.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateError).toContain("离线");
  expect(current.update).toHaveBeenCalledOnce();
  online.onLine = true;
  current.update.mockRejectedValueOnce(new Error("HTTP 503"));
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateError).toContain("503");
  await pwa.checkForUpdates();
  expect(pwa.getPwaState()).toMatchObject({ updateStatus: "current", updateError: null });
});

it("does not report the current version when update resolves but the server cannot be reached", async () => {
  const pwa = await boot();
  online.onLine = false;
  shellReplies.install = () => ({ ok: false, error: "Network unavailable" });
  await pwa.checkForUpdates();
  expect(current.update).toHaveBeenCalledOnce();
  expect(current.active!.postMessage).toHaveBeenCalledWith({ type: "INSTALL_SHELL", base: location.origin }, expect.any(Array));
  shellReplies.install = () => ({ ok: true, result: { status: "current", id: "shell" } });
  expect(pwa.getPwaState()).toMatchObject({ updateStatus: "error" });
  expect(pwa.getPwaState().updateError).toContain("离线");
  await pwa.checkForUpdates();
  expect(pwa.getPwaState()).toMatchObject({ updateStatus: "current", updateError: null });
});

it("reports failed installation and clears statechange listeners", async () => {
  const pwa = await boot();
  const worker = new Worker(); current.installing = worker;
  const remove = vi.spyOn(worker, "removeEventListener");
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(0);
  worker.change("redundant"); await checking;
  expect(pwa.getPwaState().updateError).toContain("下载失败");
  expect(remove).toHaveBeenCalledWith("statechange", expect.any(Function));
});

it("times out a hung check and ignores its late completion", async () => {
  const pwa = await boot();
  let resolve!: () => void;
  current.update.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(30_001); await checking;
  expect(pwa.getPwaState().updateError).toContain("超时");
  resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(pwa.getPwaState().updateStatus).toBe("error");
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateStatus).toBe("current");
});

it("keeps a prepared update retryable when activation fails or times out", async () => {
  const pwa = await boot();
  const worker = new Worker(); current.waiting = worker;
  options.onNeedRefresh?.();
  options.onNeedReload?.();
  expect(reload).not.toHaveBeenCalled();
  worker.postMessage.mockImplementationOnce(() => { throw new Error("message failed"); });
  await pwa.applyUpdate();
  expect(pwa.getPwaState()).toMatchObject({ updateAvailable: true, updateStatus: "error" });
  const applying = pwa.applyUpdate();
  await vi.advanceTimersByTimeAsync(30_001); await applying;
  expect(pwa.getPwaState().updateError).toContain("超时");
  expect(pwa.getPwaState().updateAvailable).toBe(true);
  container.controller = worker; container.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
});

it("handles delayed registration and registration errors without hanging", async () => {
  const pwa = await boot(false);
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(0);
  options.onRegisterError?.(new Error("registration failed"));
  await checking;
  expect(pwa.getPwaState().updateError).toContain("registration failed");
  register.mockImplementationOnce((next: Options) => {
    queueMicrotask(() => next.onRegisteredSW?.("/sw.js", current as unknown as ServiceWorkerRegistration));
  });
  await pwa.checkForUpdates();
  expect(register).toHaveBeenCalledTimes(2);
  expect(pwa.getPwaState().updateStatus).toBe("current");
});

it("does not mistake first-time offline installation for an application update", async () => {
  container.controller = null; current.active = null;
  const pwa = await boot();
  const worker = new Worker(); current.installing = worker;
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(0);
  worker.change("activated"); current.installing = null;
  await checking;
  expect(pwa.getPwaState()).toMatchObject({ updateAvailable: false, updateStatus: "current" });
  expect(reload).not.toHaveBeenCalled();
});

it("reports installation timeouts and removes the obsolete listener", async () => {
  const pwa = await boot();
  const worker = new Worker(); current.installing = worker;
  const remove = vi.spyOn(worker, "removeEventListener");
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(30_001); await checking;
  expect(pwa.getPwaState().updateError).toContain("下载超时");
  expect(remove).toHaveBeenCalledOnce();
});

it("keeps update error metadata so the same failure can be shown in another language", async () => {
  const pwa = await boot();
  online.onLine = false;
  current.update.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await pwa.checkForUpdates();
  const { renderMessage } = await import("@llm-chat/i18n");
  const state = pwa.getPwaState();
  expect(state.updateError).toContain("离线");
  expect(renderMessage("en-US", { message: state.updateError!, i18n: state.updateErrorI18n! })).toContain("offline");
  expect(renderMessage("zh-CN", { message: state.updateError!, i18n: state.updateErrorI18n! })).toBe(state.updateError);
});

it("downloads a newer shell through the worker and activates it only when applied", async () => {
  const pwa = await boot();
  shellReplies.install = () => ({ ok: true, result: { status: "staged", id: "next" } });
  await pwa.checkForUpdates();
  expect(pwa.getPwaState()).toMatchObject({ updateAvailable: true, updateStatus: "ready" });
  expect(reload).not.toHaveBeenCalled();
  await pwa.applyUpdate();
  expect(current.active!.postMessage).toHaveBeenCalledWith({ type: "ACTIVATE_SHELL", id: "next" }, expect.any(Array));
  expect(reload).toHaveBeenCalledOnce();
});

it("keeps a staged shell retryable when activation fails", async () => {
  const pwa = await boot();
  shellReplies.install = () => ({ ok: true, result: { status: "staged", id: "next" } });
  shellReplies.activate = () => ({ ok: false, error: "gone" });
  await pwa.checkForUpdates();
  await pwa.applyUpdate();
  expect(pwa.getPwaState()).toMatchObject({ updateAvailable: true, updateStatus: "error" });
  expect(pwa.getPwaState().updateError).toContain("启用失败");
  expect(reload).not.toHaveBeenCalled();
});

it("asks for the page address when the release changes the worker protocol", async () => {
  const pwa = await boot();
  shellReplies.install = () => ({ ok: true, result: { status: "protocol", protocol: 2 } });
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateError).toContain(location.origin);
});

it("checks the active channel for updates even when the page origin is unreachable", async () => {
  localStorage.setItem("llm-chat.server-channels.v1", JSON.stringify({ channels: ["http://localhost:4000"], active: "http://localhost:4000", boundServerId: null }));
  const pwa = await boot();
  current.update.mockRejectedValue(new TypeError("page origin unreachable"));
  shellReplies.install = () => ({ ok: true, result: { status: "staged", id: "next" } });
  await pwa.checkForUpdates();
  expect(current.active!.postMessage).toHaveBeenCalledWith({ type: "INSTALL_SHELL", base: "http://localhost:4000" }, expect.any(Array));
  expect(pwa.getPwaState().updateStatus).toBe("ready");
  container.register.mockRejectedValue(new TypeError("page origin unreachable"));
  shellReplies.install = () => ({ ok: true, result: { status: "current", id: "shell" } });
  await pwa.forceUpdate();
  expect(fetch).toHaveBeenCalledWith("http://localhost:4000/app-shell.json", expect.objectContaining({ mode: "cors", credentials: "omit" }));
  expect(current.active!.postMessage).toHaveBeenCalledWith({ type: "INSTALL_SHELL", base: "http://localhost:4000", force: true }, expect.any(Array));
  expect(reload).toHaveBeenCalledOnce();
});

function prepareRepair() {
  container.register.mockResolvedValue(current);
}

it("queues force update behind a pending check instead of losing the manual action", async () => {
  const pwa = await boot(); prepareRepair();
  let resolve!: () => void;
  current.update.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
  const checking = pwa.checkForUpdates();
  await vi.advanceTimersByTimeAsync(0);
  const forcing = pwa.forceUpdate();
  expect(forcing).not.toBe(checking);
  expect(pwa.forceUpdate()).toBe(forcing);
  expect(container.register).not.toHaveBeenCalled();
  resolve();
  await Promise.all([checking, forcing]);
  expect(container.register).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});

it("repairs the same version without a waiting update and refreshes only after success", async () => {
  const pwa = await boot(); prepareRepair();
  const first = pwa.forceUpdate();
  expect(pwa.forceUpdate()).toBe(first);
  await first;
  expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  expect(container.controller!.postMessage).toHaveBeenCalledWith({ type: "INSTALL_SHELL", base: location.origin, force: true }, expect.any(Array));
  expect(container.controller!.postMessage).toHaveBeenCalledWith({ type: "ACTIVATE_SHELL", id: "shell" }, expect.any(Array));
  expect(reload).toHaveBeenCalledOnce();
});

it("keeps a failed repair retryable without reloading or requiring an available update", async () => {
  const pwa = await boot(); prepareRepair();
  shellReplies.install = () => ({ ok: false, error: "integrity" });
  await pwa.forceUpdate();
  expect(pwa.getPwaState().updateError).toContain("修复失败");
  expect(reload).not.toHaveBeenCalled();
  shellReplies.install = () => ({ ok: true, result: { status: "current", id: "shell" } });
  await pwa.forceUpdate();
  expect(reload).toHaveBeenCalledOnce();
});

it("attempts an update despite offline telemetry and stops on actual server failure", async () => {
  const pwa = await boot(); prepareRepair(); online.onLine = false;
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Network unavailable"));
  await pwa.forceUpdate();
  expect(fetch).toHaveBeenCalled();
  expect(container.register).not.toHaveBeenCalled();
  online.onLine = true;
  vi.mocked(fetch).mockResolvedValueOnce(new Response("down", { status: 503 }));
  await pwa.forceUpdate();
  expect(pwa.getPwaState().updateError).toContain("服务器");
  expect(container.register).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("rejects a repair that another worker takes over", async () => {
  const pwa = await boot(); prepareRepair();
  shellReplies.activate = () => { container.controller = new Worker(); return { ok: true }; };
  await pwa.forceUpdate();
  expect(pwa.getPwaState().updateError).toContain("版本已变化");
  expect(reload).not.toHaveBeenCalled();
});

it("times out a worker that does not answer and closes the channel", async () => {
  const pwa = await boot(); prepareRepair();
  shellReplies.install = () => undefined;
  const updating = pwa.forceUpdate();
  await vi.advanceTimersByTimeAsync(120_001); await updating;
  expect(pwa.getPwaState().updateStatus).toBe("error");
  expect(reload).not.toHaveBeenCalled();
});
