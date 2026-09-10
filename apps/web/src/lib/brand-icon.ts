// Shared geometry for installed icons and the browser favicon.
export const APP_ICON_PATH = "M768 224H256V800H768V608H640V672H384V352H640V416H768Z";

export function createBrandIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#000000"/><path fill="#FFFFFF" d="${APP_ICON_PATH}"/></svg>`;
}
