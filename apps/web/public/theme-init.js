// Run before styles and the application bundle so PWA chrome starts in the saved theme.
// Keep the storage key and palette aligned with local-display.ts and theme.ts.
(() => {
  let preferences;
  try {
    preferences = JSON.parse(localStorage.getItem("llm-chat.display.v1") || "null");
  } catch { /* Use the system theme when storage is unavailable or invalid. */ }
  const theme = preferences?.theme;
  const resolved = theme === "light" || theme === "dark"
    ? theme
    : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const amoled = preferences?.amoled === true && resolved === "dark";
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.amoled = String(amoled);
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="color-scheme"]').content = resolved;
  document.querySelector('meta[name="theme-color"]').content = amoled
    ? "#000000" : resolved === "light" ? "#f5f7f5" : "#0d100e";
})();
