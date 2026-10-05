/// <reference types="vite-plugin-pwa/client" />
import { t, localizedError, type MessageKey } from "./i18n";

import { errorI18n, type LocalizedMessage } from "@llm-chat/i18n";
import { registerSW } from "virtual:pwa-register";
import type { ShellInstallResult } from "./app-shell";
import { apiBase } from "./server-channel";

export interface PwaState {
  supported: boolean;
  updateAvailable: boolean;
  installAvailable: boolean;
  offlineReady: boolean;
  updateStatus: "idle" | "checking" | "downloading" | "current" | "ready" | "applying" | "repairing" | "error";
  updateError: string | null;
  updateErrorI18n?: LocalizedMessage | undefined;
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
type Operation = "check" | "apply" | "force";
const operations = new Map<Operation, Promise<void>>();
let operationTail = Promise.resolve();
let finishActivation: (() => void) | null = null;
let watchingUpdates = false;
let stagedShell: string | null = null;
const UPDATE_TIMEOUT = 30_000;
const SHELL_TIMEOUT = 120_000;

/** Updates come from the active server channel; the page origin is only one of them. */
function updateBase(): string {
  return apiBase() || location.origin;
}

type ShellCommand = { type: "INSTALL_SHELL"; base: string; force?: boolean } | { type: "ACTIVATE_SHELL"; id: string };
async function shellCommand<T>(worker: ServiceWorker, command: ShellCommand, failed: (detail: string) => Error, key: MessageKey, timeout: number): Promise<T> {
  const channel = new MessageChannel();
  try {
    return await withTimeout(new Promise<T>((resolve, reject) => {
      channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean; result?: T; error?: string }>) => {
        if (event.data?.ok === true) resolve(event.data.result as T);
        else reject(failed(event.data?.error ?? ""));
      };
      worker.postMessage(command, [channel.port2]);
    }), key, timeout);
  } finally { channel.port1.close(); channel.port2.close(); }
}

function installShell(worker: ServiceWorker, force = false): Promise<ShellInstallResult> {
  return shellCommand<ShellInstallResult>(worker, { type: "INSTALL_SHELL", base: updateBase(), ...(force ? { force } : {}) },
    force ? () => localizedError("pwa.repair_failed_try_again") : (detail) => localizedError("pwa.update_check_failed", { value1: detail }),
    force ? "pwa.repair_failed_try_again" : "pwa.download_timed_out_try_again", SHELL_TIMEOUT);
}

function protocolChanged(): Error {
  return localizedError("pwa.update_requires_page_address", { value1: location.origin });
}

function ready(): void {
  emit({ updateAvailable: true, updateStatus: ["applying", "repairing"].includes(state.updateStatus) ? state.updateStatus : "ready", updateError: null });
}

function failure(error: unknown): void {
  if (navigator.onLine === false) error = localizedError("pwa.you_are_offline_connect_and_try_again");
  emit({ updateStatus: "error", updateErrorI18n: errorI18n(error), updateError: error instanceof Error ? error.message : t("SettingsView.update_failed_try_again") });
}

function withTimeout<T>(promise: Promise<T>, key: MessageKey, timeout = UPDATE_TIMEOUT): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(localizedError(key)), timeout);
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
    }), "pwa.update_service_is_not_ready_try_again");
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
        if (worker.state === "redundant") reject(localizedError("pwa.could_not_download_the_new_version_try_again"));
        else if (["installed", "activating", "activated"].includes(worker.state)) resolve();
      };
      worker.addEventListener("statechange", changed);
      cleanup = () => worker.removeEventListener("statechange", changed);
      changed();
    }), "pwa.download_timed_out_try_again");
  } finally { cleanup(); }
}

function runOperation(kind: Operation, action: () => Promise<void>): Promise<void> {
  const pending = operations.get(kind);
  if (pending) return pending;
  const next = operationTail.then(action).catch(failure).finally(() => { operations.delete(kind); });
  operations.set(kind, next);
  operationTail = next;
  return next;
}

/** Manual checks bypass the automatic foreground-check throttle. */
export function checkForUpdates(): Promise<void> {
  return runOperation("check", async () => {
    if (!state.supported) throw localizedError("pwa.this_browser_does_not_support_app_updates_refresh_the_page");
    emit({ updateStatus: "checking", updateError: null });
    const current = await getRegistration();
    const hadActiveWorker = Boolean(current.active || navigator.serviceWorker.controller);
    const workerCheck = withTimeout(current.update().catch((error: unknown) => {
      throw localizedError("pwa.update_check_failed", { value1: (error instanceof Error ? error.message : String(error)) });
    }), "pwa.update_check_timed_out_try_again");
    // Browsers fetch the worker script only from the page origin. Another
    // channel may stand in for an unreachable origin; its shell check decides.
    if (apiBase()) await workerCheck.catch(() => {});
    else await workerCheck;
    if (current.installing) {
      emit({ updateStatus: "downloading" });
      await waitForInstallation(current.installing);
      if (hadActiveWorker) { ready(); return; }
    }
    if (current.waiting || state.updateAvailable) { ready(); return; }
    // Chromium can resolve update() using the existing worker while offline,
    // and worker requests can miss the page's offline state; probe from here.
    await publishedShell();
    const worker = current.active;
    if (worker) {
      const result = await installShell(worker);
      if (result.status === "protocol") throw protocolChanged();
      if (result.status === "staged") { stagedShell = result.id; ready(); return; }
    }
    emit({ updateStatus: "current", updateError: null });
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
    onNeedReload() { finishActivation?.(); },
    onOfflineReady() { emit({ offlineReady: true }); },
    onRegisterError(error) {
      registrationError = localizedError("pwa.could_not_start_the_update_service", { value1: (error instanceof Error ? error.message : String(error)) });
      failure(registrationError);
    },
    onRegisteredSW(_url, next) {
      registration = next;
      if (!next) {
        registrationError = localizedError("pwa.could_not_start_the_update_service_refresh_and_try_again");
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

async function activateWorker(worker: ServiceWorker): Promise<void> {
  if (navigator.serviceWorker.controller === worker) return;
  let cleanup = () => {};
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      let finished = false;
      const changed = () => {
        if (finished || navigator.serviceWorker.controller !== worker) return;
        finished = true;
        resolve();
      };
      finishActivation = changed;
      const failed = () => {
        if (worker.state === "redundant") reject(localizedError("pwa.could_not_apply_the_new_version_try_again"));
      };
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      worker.addEventListener("statechange", failed);
      cleanup = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
        worker.removeEventListener("statechange", failed);
        finishActivation = null;
      };
      worker.postMessage({ type: "SKIP_WAITING" });
      changed();
    }), "pwa.applying_the_new_version_timed_out_try_again");
  } finally { cleanup(); }
}

function reloadUpdatedPage(): void {
  emit({ updateAvailable: false, updateStatus: "current", updateError: null });
  window.location.reload();
}

export function applyUpdate(): Promise<void> {
  return runOperation("apply", async () => {
    if (!state.updateAvailable) return;
    emit({ updateStatus: "applying", updateError: null });
    const current = await getRegistration();
    // Another tab may have activated the prepared version already.
    if (current.waiting) await activateWorker(current.waiting);
    else if (stagedShell && current.active) {
      await shellCommand(current.active, { type: "ACTIVATE_SHELL", id: stagedShell }, () => localizedError("pwa.could_not_apply_the_new_version_try_again"),
        "pwa.applying_the_new_version_timed_out_try_again", UPDATE_TIMEOUT);
    }
    reloadUpdatedPage();
  });
}

/** Fails fast when the update channel cannot serve the release. */
async function publishedShell(): Promise<void> {
  const response = await fetch(new URL("/app-shell.json", updateBase()).href, {
    cache: "no-store", mode: "cors", credentials: "omit", signal: AbortSignal.timeout(UPDATE_TIMEOUT)
  });
  if (!response.ok) throw localizedError("pwa.server_not_ready_for_update");
}

/** Repair the current release even when the service worker has not changed. */
export function forceUpdate(): Promise<void> {
  return runOperation("force", async () => {
    if (!state.supported) throw localizedError("pwa.this_browser_does_not_support_app_updates_refresh_the_page");
    emit({ updateStatus: "checking", updateError: null });
    await publishedShell();
    let current: ServiceWorkerRegistration;
    try {
      current = await withTimeout(navigator.serviceWorker.register("/sw.js", {
        scope: "/", updateViaCache: "none"
      }), "pwa.update_check_timed_out_try_again");
      registration = current;
      registrationError = null;
      await withTimeout(current.update(), "pwa.update_check_timed_out_try_again");
    } catch (error) {
      // The installed worker can still repair the shell from another channel.
      if (!apiBase()) throw error;
      current = await getRegistration();
    }
    emit({ updateStatus: "downloading" });
    if (current.installing) await waitForInstallation(current.installing);
    const worker = current.waiting ?? current.active;
    if (!worker) throw localizedError("pwa.update_service_is_not_ready_try_again");
    emit({ updateStatus: "applying" });
    await activateWorker(worker);
    emit({ updateStatus: "repairing" });
    const result = await installShell(worker, true);
    if (result.status === "protocol") throw protocolChanged();
    await shellCommand(worker, { type: "ACTIVATE_SHELL", id: result.id }, () => localizedError("pwa.repair_failed_try_again"),
      "pwa.repair_failed_try_again", UPDATE_TIMEOUT);
    if (navigator.serviceWorker.controller !== worker) throw localizedError("pwa.version_changed_try_again");
    reloadUpdatedPage();
  });
}
