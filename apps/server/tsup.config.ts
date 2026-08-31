import { defineConfig } from "tsup";

export default defineConfig({
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
