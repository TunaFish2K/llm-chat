import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { APP_ICON_PATH, createBrandIconSvg, FAVICON_PALETTES } from "../apps/web/src/lib/brand-icon";

const directory = new URL("../apps/web/public/icons/", import.meta.url);
await mkdir(directory, { recursive: true });
const source = createBrandIconSvg();
const outputs = [
  ["icon-32-v2.png", 32], ["apple-touch-icon-180-v2.png", 180], ["icon-192-v2.png", 192],
  ["icon-512-v2.png", 512], ["icon-maskable-512-v2.png", 512], ["icon-1024-v2.png", 1024]
] as const;
const { light, dark } = FAVICON_PALETTES;
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><style>.background{fill:${light.background}}.mark{fill:${light.foreground}}@media(prefers-color-scheme:dark){.background{fill:${dark.background}}.mark{fill:${dark.foreground}}}</style><rect class="background" width="1024" height="1024"/><path class="mark" d="${APP_ICON_PATH}"/></svg>`;
await Promise.all([
  writeFile(new URL("icon-v2.svg", directory), source + "\n"),
  writeFile(new URL("favicon-v2.svg", directory), favicon + "\n"),
  ...outputs.map(([name, size]) => sharp(Buffer.from(source), { density: 192 }).resize(size, size)
    .flatten({ background: "#000000" }).png({ compressionLevel: 9 }).toFile(new URL(name, directory).pathname))
]);
console.log(`Generated ${outputs.length} PNG icons and 2 SVG icons.`);
