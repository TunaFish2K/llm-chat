import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/plugin-host.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  external: ["node:sqlite", "sqlite"],
  noExternal: ["@llm-chat/contracts", "@llm-chat/providers"]
});
