import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT_INPUTS = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]);
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "coverage", "test", "__tests__", "test-results"]);

function isBuildInput(path: string): boolean {
  if (ROOT_INPUTS.has(path)) return true;
  const parts = path.split("/");
  return ["apps", "packages", "scripts"].includes(parts[0]!)
    && !parts.some((part) => EXCLUDED_DIRS.has(part) || part.startsWith("."))
    && !/\.(?:test|test-suite|spec)\.[^/]+$|test-helpers?/.test(path)
    && (path.startsWith("apps/web/public/") || /\.(?:[cm]?[jt]sx?|json|ya?ml|html|css|svg|png|ico|woff2?|webmanifest)$/.test(path));
}

export function resolveBuildId(root: string): string {
  const files: string[] = [];
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isBuildInput(relative(root, path))) files.push(relative(root, path));
    }
  };
  for (const dir of ["apps", "packages", "scripts"]) walk(join(root, dir));
  for (const file of ROOT_INPUTS) if (existsSync(join(root, file))) files.push(file);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = readFileSync(join(root, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  const contentId = hash.digest("hex").slice(0, 12);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(root)) {
      const revision = git("rev-parse", "HEAD").slice(0, 12);
      const changed = `${git("diff", "--name-only", "-z", "HEAD")}\0${git("ls-files", "--others", "--exclude-standard", "-z")}`;
      return changed.split("\0").some(isBuildInput) ? `${revision}-dirty-${contentId}` : revision;
    }
  } catch { /* Source archives do not require Git. */ }
  const revisionFile = join(root, "BUILD_REVISION");
  const revision = existsSync(revisionFile) ? readFileSync(revisionFile, "utf8").trim() : "";
  return /^[a-f0-9]{40,64}$/.test(revision) ? revision.slice(0, 12) : `source-${contentId}`;
}
