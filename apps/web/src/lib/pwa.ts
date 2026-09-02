/// <reference types="vite-plugin-pwa/client" />

import { registerSW } from "virtual:pwa-register";

export interface PwaState {
  supported: boolean;
  updateAvailable: boolean;
  installAvailable: boolean;
  offlineReady: boolean;
}

type PwaListener = (state: PwaState) => void;
type InstallPrompt = Event & { prompt(): Promise<void> };

let state: PwaState = {
  supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  updateAvailable: false,
  installAvailable: false,
  offlineReady: false
};
const listeners = new Set<PwaListener>();
let deferredInstall: InstallPrompt | null = null;
let initialized = false;
let updateWorker: ((reloadPage?: boolean) => Promise<void>) | null = null;

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
  updateWorker = registerSW({
    immediate: true,
    onNeedRefresh() { emit({ updateAvailable: true }); },
    onOfflineReady() { emit({ offlineReady: true }); },
    onRegisteredSW(_url, registration) {
      window.setInterval(() => void registration?.update(), 60 * 60 * 1000);
    }
  });
}

export async function promptInstall(): Promise<void> {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  deferredInstall = null;
  emit({ installAvailable: false });
}

export function applyUpdate(): void {
  emit({ updateAvailable: false });
  void updateWorker?.(true);
}
