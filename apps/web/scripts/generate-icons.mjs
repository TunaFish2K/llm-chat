// Generates simple PNG icons for the PWA without external dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      const premultiplied = [0, 0, 0];
      for (let sampleY = 0; sampleY < 3; sampleY++) {
        for (let sampleX = 0; sampleX < 3; sampleX++) {
          const [r, g, b, a] = draw(
            (x + (sampleX + 0.5) / 3) / size,
            (y + (sampleY + 0.5) / 3) / size
          );
          alpha += a;
          premultiplied[0] += r * a;
          premultiplied[1] += g * a;
          premultiplied[2] += b * a;
        }
      }
      const a = Math.round(alpha / 9);
      const r = alpha ? Math.round(premultiplied[0] / alpha) : 0;
      const g = alpha ? Math.round(premultiplied[1] / alpha) : 0;
      const b = alpha ? Math.round(premultiplied[2] / alpha) : 0;
      const p = row + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function roundedSquareDistance(u, v, half, radius) {
  const qx = Math.abs(u - 0.5) - (half - radius);
  const qy = Math.abs(v - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const CORAL = [241, 105, 76];
const WARM_WHITE = [255, 248, 242];
const DEEP_JADE = [21, 67, 56];

function icon(maskable = false) {
  return (u, v) => {
    if (!maskable && roundedSquareDistance(u, v, 0.465, 0.15) > 0) return [0, 0, 0, 0];
    let color = CORAL;

    // An open conversation loop doubles as the letter C at small sizes.
    const x = (u - 0.47) / 0.255;
    const y = (v - 0.47) / 0.215;
    const radius = Math.hypot(x, y);
    const angle = Math.atan2(y, x);
    const loop = Math.abs(radius - 1) < 0.115 && Math.abs(angle) > 0.58;
    if (loop) color = WARM_WHITE;

    const endpointX = 0.47 + 0.255 * Math.cos(0.58);
    const endpointY = 0.47 + 0.215 * Math.sin(0.58);
    if (Math.hypot(u - endpointX, v - endpointY) < 0.052) color = DEEP_JADE;
    return [...color, 255];
  };
}

for (const size of [32, 192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, icon()));
}
writeFileSync(join(outDir, "icon-maskable-512.png"), png(512, icon(true)));
console.log("icons written to", outDir);
