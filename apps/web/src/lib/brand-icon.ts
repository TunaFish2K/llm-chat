// Shared geometry for installed icons and the themed browser favicon.
export const APP_ICON_PATH = "M768 224H256V800H768V608H640V672H384V352H640V416H768Z";
export const FAVICON_PALETTES = {
  dark: { background: "#000000", foreground: "#ff8964" },
  light: { background: "#FFFFFF", foreground: "#c64b2f" }
} as const;

export function createBrandIconSvg(background = "#000000", foreground = "#FFFFFF"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${background}"/><path fill="${foreground}" d="${APP_ICON_PATH}"/></svg>`;
}

export function updateFavicon(theme: "dark" | "light"): void {
  const palette = FAVICON_PALETTES[theme];
  document.getElementById("app-favicon")?.setAttribute("href",
    `data:image/svg+xml,${encodeURIComponent(createBrandIconSvg(palette.background, palette.foreground))}`);
}
