import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveBuildId } from "../../build-identity";
import { BUILD_ID } from "./build-info";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "llm-chat-build-"));
  directories.push(root);
  mkdirSync(join(root, "apps/server/src"), { recursive: true });
  writeFileSync(join(root, "apps/server/src/index.ts"), "export const value = 1;");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
  return root;
}

it("uses a stable source fingerprint without Git and ignores generated files", () => {
  const root = fixture();
  const first = resolveBuildId(root);
  expect(first).toMatch(/^source-[a-f0-9]{12}$/);
  mkdirSync(join(root, "apps/server/dist"));
  writeFileSync(join(root, "apps/server/dist/index.js"), "built");
  writeFileSync(join(root, "apps/server/src/index.test.ts"), "test");
  expect(resolveBuildId(root)).toBe(first);
  writeFileSync(join(root, "pnpm-lock.yaml"), "changed dependencies");
  expect(resolveBuildId(root)).not.toBe(first);
  const changedDependencies = resolveBuildId(root);
  mkdirSync(join(root, "apps/web/public"), { recursive: true });
  writeFileSync(join(root, "apps/web/public/image.avif"), "image bytes");
  expect(resolveBuildId(root)).not.toBe(changedDependencies);
  expect(BUILD_ID).toBe("development");
});

it("identifies clean checkouts, dirty inputs and exported source archives", () => {
  const root = fixture();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "Build test");
  git("config", "user.email", "build@example.invalid");
  writeFileSync(join(root, ".gitattributes"), "BUILD_REVISION export-subst\n");
  writeFileSync(join(root, "BUILD_REVISION"), "$Format:%H$\n");
  git("add", "."); git("commit", "-m", "fixture");
  const revision = git("rev-parse", "HEAD").slice(0, 12);
  expect(resolveBuildId(root)).toBe(revision);
  const archive = execFileSync("git", ["-C", root, "archive", "HEAD"]);
  const exported = fixture();
  execFileSync("tar", ["-x", "-C", exported], { input: archive });
  expect(resolveBuildId(exported)).toBe(revision);
  writeFileSync(join(root, "apps/server/src/index.ts"), "export const value = 2;");
  const dirty = resolveBuildId(root);
  expect(dirty).toMatch(new RegExp(`^${revision}-dirty-[a-f0-9]{12}$`));
  expect(resolveBuildId(root)).toBe(dirty);
  writeFileSync(join(root, "apps/server/src/new.ts"), "new input");
  expect(resolveBuildId(root)).not.toBe(dirty);
  git("checkout", "--", "apps/server/src/index.ts");
  rmSync(join(root, "apps/server/src/new.ts"));
  expect(resolveBuildId(root)).toBe(revision);
});
