import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerSW } from "virtual:pwa-register";
import "./styles.css";

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("llm-chat-update-ready", { detail: () => updateSW(true) }));
  },
  onOfflineReady() {
    window.dispatchEvent(new Event("llm-chat-offline-ready"));
  },
  onRegisteredSW(_url, registration) {
    window.setInterval(() => void registration?.update(), 60 * 60 * 1000);
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
