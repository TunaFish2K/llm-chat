import { defineConfig } from "vitest/config";

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
            "apps/web/src/**/*.node.test.{ts,tsx}",
            "apps/web/src/api.test.ts",
            "apps/web/src/generationState.test.ts",
            "apps/web/src/uiPreferences.test.ts",
            "packages/**/*.test.{ts,tsx}"
          ]
        }
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          pool: "threads",
          testTimeout: 120_000,
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          exclude: [
            "apps/web/src/**/*.node.test.{ts,tsx}",
            "apps/web/src/api.test.ts",
            "apps/web/src/generationState.test.ts",
            "apps/web/src/uiPreferences.test.ts"
          ],
          setupFiles: ["apps/web/src/test/setup.ts"]
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
        "apps/web/src/sw.ts"
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
        "apps/server/src/generations.ts": criticalCoverageThreshold,
        "apps/server/src/mcp.ts": criticalCoverageThreshold,
        "apps/server/src/tools.ts": criticalCoverageThreshold,
        "apps/web/src/Markdown.tsx": criticalCoverageThreshold,
        "apps/web/src/api.ts": criticalCoverageThreshold,
        "apps/web/src/generationState.ts": criticalCoverageThreshold
      }
    }
  }
});
