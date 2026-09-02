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
      const [r, g, b, a] = draw(x / size, y / size);
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

function icon(u, v) {
  // Rounded-square aurora gradient with a speech-bubble dot motif.
  const cx = u - 0.5, cy = v - 0.5;
  const r = Math.max(Math.abs(cx), Math.abs(cy));
  const radius = 0.5;
  const corner = 0.16;
  const qx = Math.abs(cx) - (radius - corner), qy = Math.abs(cy) - (radius - corner);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
  if (d > 0) return [0, 0, 0, 0];
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  const top = [124, 108, 255], bottom = [54, 199, 216];
  let color = [mix(top[0], bottom[0], v), mix(top[1], bottom[1], v), mix(top[2], bottom[2], v)];
  // bubble
  const bx = u - 0.5, by = v - 0.46;
  const bubble = Math.hypot(bx / 0.26, by / 0.2) < 1 && !(u > 0.42 && u < 0.5 && v > 0.55 && v < 0.68 && u < 0.5 - (v - 0.55) * 0.6);
  if (bubble) color = [255, 255, 255];
  // three dots
  for (const dx of [-0.11, 0, 0.11]) {
    if (Math.hypot(u - (0.5 + dx), v - 0.46) < 0.035) color = [124, 108, 255];
  }
  return [...color, 255];
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, icon));
}
writeFileSync(join(outDir, "icon-maskable-512.png"), png(512, icon));
console.log("icons written to", outDir);
