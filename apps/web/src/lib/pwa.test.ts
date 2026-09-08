import { afterEach, beforeEach, expect, it, vi } from "vitest";

const register = vi.hoisted(() => vi.fn());
vi.mock("virtual:pwa-register", () => ({ registerSW: register }));
type Options = NonNullable<Parameters<typeof import("virtual:pwa-register").registerSW>[0]>;

class Worker extends EventTarget {
  state = "installing";
  postMessage = vi.fn();
  change(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}
let container: EventTarget & { controller: Worker | null };
let current: { active: Worker | null; waiting: Worker | null; installing: Worker | null; update: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
let options: Options;
let online: { onLine: boolean; serviceWorker: typeof container };

beforeEach(() => {
  vi.resetModules(); register.mockReset(); vi.useFakeTimers();
  container = Object.assign(new EventTarget(), { controller: new Worker() as Worker | null });
  current = { active: container.controller, waiting: null, installing: null, update: vi.fn() };
  current.update.mockResolvedValue(current);
  online = { onLine: true, serviceWorker: container };
  vi.stubGlobal("navigator", online);
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
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateError).toContain("离线");
  expect(current.update).not.toHaveBeenCalled();
  online.onLine = true;
  current.update.mockRejectedValueOnce(new Error("HTTP 503"));
  await pwa.checkForUpdates();
  expect(pwa.getPwaState().updateError).toContain("503");
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
