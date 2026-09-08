/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

export interface PwaState {
  supported: boolean;
  updateAvailable: boolean;
  installAvailable: boolean;
  offlineReady: boolean;
  updateStatus: "idle" | "checking" | "downloading" | "current" | "ready" | "applying" | "error";
  updateError: string | null;
}

type PwaListener = (state: PwaState) => void;
type InstallPrompt = Event & { prompt(): Promise<void> };

let state: PwaState = {
  supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  updateAvailable: false,
  installAvailable: false,
  offlineReady: false,
  updateStatus: "idle",
  updateError: null
};
const listeners = new Set<PwaListener>();
let deferredInstall: InstallPrompt | null = null;
let initialized = false;
let registration: ServiceWorkerRegistration | undefined;
let registrationError: Error | null = null;
let lastUpdateCheck = 0;
let operation: Promise<void> | null = null;
let finishReload: (() => void) | null = null;
let watchingUpdates = false;
const UPDATE_TIMEOUT = 30_000;

function ready(): void {
  emit({ updateAvailable: true, updateStatus: state.updateStatus === "applying" ? "applying" : "ready", updateError: null });
}

function failure(error: unknown): void {
  emit({ updateStatus: "error", updateError: error instanceof Error ? error.message : "更新失败，请重试" });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), UPDATE_TIMEOUT);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  if (!initialized) initPwa();
  if (registration) return registration;
  if (registrationError) {
    registrationError = null;
    registerServiceWorker();
    if (registration) return registration;
    if (registrationError) throw registrationError;
  }
  let unsubscribe = () => {};
  try {
    return await withTimeout(new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      unsubscribe = subscribePwa(() => {
        if (registration) resolve(registration);
        else if (registrationError) reject(registrationError);
      });
    }), "更新服务尚未就绪，请重试");
  } catch (error) {
    if (!registration) registrationError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally { unsubscribe(); }
}

async function waitForInstallation(worker: ServiceWorker): Promise<void> {
  let cleanup = () => {};
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (worker.state === "redundant") reject(new Error("新版下载失败，请重试"));
        else if (["installed", "activating", "activated"].includes(worker.state)) resolve();
      };
      worker.addEventListener("statechange", changed);
      cleanup = () => worker.removeEventListener("statechange", changed);
      changed();
    }), "新版下载超时，请重试");
  } finally { cleanup(); }
}

function runOperation(action: () => Promise<void>): Promise<void> {
  if (operation) return operation;
  operation = Promise.resolve().then(action).catch(failure).finally(() => { operation = null; });
  return operation;
}

/** Manual checks bypass the automatic foreground-check throttle. */
export function checkForUpdates(): Promise<void> {
  return runOperation(async () => {
    if (!state.supported) throw new Error("当前浏览器不支持应用更新，请刷新页面");
    if (navigator.onLine === false) throw new Error("当前离线，请连接网络后重试");
    emit({ updateStatus: "checking", updateError: null });
    const current = await getRegistration();
    const hadActiveWorker = Boolean(current.active || navigator.serviceWorker.controller);
    await withTimeout(current.update().catch((error: unknown) => {
      throw new Error(`检查更新失败：${error instanceof Error ? error.message : String(error)}`);
    }), "检查更新超时，请重试");
    if (current.installing) {
      emit({ updateStatus: "downloading" });
      await waitForInstallation(current.installing);
      if (hadActiveWorker) { ready(); return; }
    }
    if (current.waiting || state.updateAvailable) ready();
    else emit({ updateStatus: "current", updateError: null });
  });
}

function emit(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function subscribePwa(listener: PwaListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPwaState(): PwaState {
  return state;
}

export function initPwa(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event as InstallPrompt;
    emit({ installAvailable: true });
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    emit({ installAvailable: false });
  });

  if (!state.supported) return;
  registerServiceWorker();
}

function registerServiceWorker(): void {
  registerSW({
    immediate: true,
    onNeedRefresh: ready,
    // Activation in another tab must not refresh this tab without confirmation.
    onNeedReload() { finishReload?.(); },
    onOfflineReady() { emit({ offlineReady: true }); },
    onRegisterError(error) {
      registrationError = new Error(`无法启动更新服务：${error instanceof Error ? error.message : String(error)}`);
      failure(registrationError);
    },
    onRegisteredSW(_url, next) {
      registration = next;
      if (!next) {
        registrationError = new Error("无法启动更新服务，请刷新页面后重试");
        failure(registrationError);
        return;
      }
      registrationError = null;
      emit({});
      if (watchingUpdates) return;
      watchingUpdates = true;
      const check = () => {
        if (document.visibilityState === "hidden" || !registration) return;
        const now = Date.now();
        if (now - lastUpdateCheck < 30_000) return;
        lastUpdateCheck = now;
        void checkForUpdates();
      };
      window.setInterval(check, 60 * 60 * 1000);
      window.addEventListener("pageshow", check);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", check);
      check();
    }
  });
}

export async function promptInstall(): Promise<void> {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  deferredInstall = null;
  emit({ installAvailable: false });
}

export function applyUpdate(): Promise<void> {
  return runOperation(async () => {
    if (!state.updateAvailable) return;
    emit({ updateStatus: "applying", updateError: null });
    const current = await getRegistration();
    const worker = current.waiting;
    // Another tab may have activated the prepared version already.
    if (!worker) { window.location.reload(); return; }
    const previousController = navigator.serviceWorker.controller;
    let cleanup = () => {};
    try {
      await withTimeout(new Promise<void>((resolve, reject) => {
        let finished = false;
        finishReload = () => {
          if (finished) return;
          finished = true;
          emit({ updateAvailable: false, updateStatus: "current", updateError: null });
          window.location.reload();
          resolve();
        };
        const changed = () => {
          if (navigator.serviceWorker.controller && navigator.serviceWorker.controller !== previousController) finishReload?.();
        };
        const failed = () => {
          if (worker.state === "redundant") reject(new Error("新版启用失败，请重试"));
        };
        navigator.serviceWorker.addEventListener("controllerchange", changed);
        worker.addEventListener("statechange", failed);
        cleanup = () => {
          navigator.serviceWorker.removeEventListener("controllerchange", changed);
          worker.removeEventListener("statechange", failed);
          finishReload = null;
        };
        worker.postMessage({ type: "SKIP_WAITING" });
      }), "启用新版超时，请重试");
    } finally { cleanup(); }
  });
}
