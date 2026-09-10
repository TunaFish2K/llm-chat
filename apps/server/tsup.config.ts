import { defineConfig } from "tsup";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveBuildId } from "./build-identity";

const buildId = resolveBuildId(fileURLToPath(new URL("../../", import.meta.url)));

export default defineConfig({
  define: { __LLM_CHAT_BUILD_ID__: JSON.stringify(buildId) },
  async onSuccess() {
    await writeFile(new URL("./dist/build-info.json", import.meta.url), `${JSON.stringify({ buildId })}\n`);
  },
  entry: {
    index: "src/index.ts",
    "plugin-host": "src/plugin-host.ts",
    "auth-reset": "src/runtime/auth-reset.ts"
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  external: ["node:sqlite", "sqlite"],
  noExternal: ["@llm-chat/contracts", "@llm-chat/providers"]
});
