import { t } from "./lib/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";

const container = document.getElementById("root");
if (!container) throw new Error(t("main.missing_root_mount_point"));

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
