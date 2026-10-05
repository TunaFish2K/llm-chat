// Lists the files the service worker serves as the application shell. Any
// channel of the server can deliver them because every entry carries SRI.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_FILE = /\.(?:js|css|html|png|svg|webmanifest|woff2)$/;
const EXCLUDED = new Set(["sw.js", "app-shell.json"]);
const MAX_BYTES = 1024 * 1024;

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

export async function writeAppShell(dist, protocol) {
  const entries = [];
  for (const path of await files(dist)) {
    const url = `/${relative(dist, path).split(sep).join("/")}`;
    if (!SHELL_FILE.test(url) || EXCLUDED.has(url.slice(1))) continue;
    const bytes = await readFile(path);
    if (bytes.length > MAX_BYTES) {
      process.stderr.write(`app-shell: skipped ${url} (${bytes.length} bytes exceeds the shell limit)\n`);
      continue;
    }
    entries.push({ url, integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}` });
  }
  entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  // Keep in sync with shellId() in src/lib/app-shell.ts.
  const id = createHash("sha256").update(JSON.stringify({ protocol, entries })).digest("hex");
  const manifest = { id, protocol, entries };
  await writeFile(join(dist, "app-shell.json"), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { protocol } = JSON.parse(await readFile(join(root, "src/app-shell-protocol.json"), "utf8"));
  const manifest = await writeAppShell(join(root, "dist"), protocol);
  process.stdout.write(`app-shell: ${manifest.entries.length} files, ${manifest.id.slice(0, 12)}\n`);
}
