import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const criticalCoverageThreshold = {
  statements: 90,
  lines: 90,
  functions: 90,
  branches: 85
};

export default defineConfig({
  test: {
    maxWorkers: 6,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "apps/server/src/**/*.test.{ts,tsx}",
            "packages/**/*.test.{ts,tsx}"
          ]
        }
      },
      {
        resolve: { alias: { "virtual:pwa-register": fileURLToPath(new URL("./apps/web/test/pwa-register.ts", import.meta.url)) } },
        test: {
          name: "web",
          environment: "jsdom",
          pool: "threads",
          testTimeout: 120_000,
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/test/setup.ts"]
        }
      }
    ],
    coverage: {
      provider: "v8",
      all: true,
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "apps/server/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        "packages/providers/src/**/*.{ts,tsx}",
        "packages/contracts/src/**/*.{ts,tsx}"
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.test-suite.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/*test-helper*.{ts,tsx}",
        "**/__tests__/**",
        "**/test/**",
        "**/*.d.ts",
        "apps/server/src/index.ts",
        "apps/server/src/plugin-host.ts",
        "apps/web/src/main.tsx",
        "apps/web/src/sw.ts",
        // View workflows are exercised by the isolated Playwright suite. The
        // unit-coverage gate remains focused on reusable frontend logic.
        "apps/web/src/App.tsx",
        "apps/web/src/components/**",
        "apps/web/src/views/**",
        "apps/web/src/lib/app-state.ts",
        "apps/web/src/lib/pwa.ts",
        "apps/web/src/lib/theme.ts",
        "apps/web/src/lib/ui.tsx"
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
        "apps/server/src/generations.ts": criticalCoverageThreshold,
        "apps/server/src/mcp.ts": criticalCoverageThreshold,
        "apps/server/src/tools.ts": criticalCoverageThreshold,
        "apps/web/src/lib/markdown.tsx": criticalCoverageThreshold,
        "apps/web/src/lib/api.ts": criticalCoverageThreshold,
        "apps/web/src/lib/sse.ts": criticalCoverageThreshold
      }
    }
  }
});
