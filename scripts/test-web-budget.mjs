import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

// Cold jsdom transforms vary across CI hosts; the per-file limit still catches regressions.
const suiteLimitMs = 90_000;
const fileLimitMs = 45_000;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "llm-chat-web-budget-"));
const reportPath = join(temporaryDirectory, "vitest.json");
const startedAt = performance.now();

function failureMessages(result) {
  const messages = [result.message, ...(result.assertionResults ?? [])
    .filter((assertion) => assertion.status === "failed")
    .flatMap((assertion) => assertion.failureMessages ?? [])]
    .map((message) => message?.trim())
    .filter(Boolean);
  return [...new Set(messages)];
}

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", [
      "exec", "vitest", "run", "--project", "web", "--maxWorkers=4", "--reporter=json", `--outputFile=${reportPath}`
    ], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Web test process ended with signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
  const elapsedMs = performance.now() - startedAt;
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const slowFiles = report.testResults
    .map((result) => ({ name: relative(process.cwd(), result.name), durationMs: result.endTime - result.startTime }))
    .filter((result) => result.durationMs > fileLimitMs)
    .sort((left, right) => right.durationMs - left.durationMs);

  console.log(`[web-budget] ${report.numPassedTests}/${report.numTotalTests} tests passed in ${(elapsedMs / 1_000).toFixed(2)}s`);
  if (exitCode !== 0 || !report.success) {
    for (const result of report.testResults.filter((item) => item.status === "failed")) {
      const details = failureMessages(result);
      console.error(`[web-budget] failed: ${relative(process.cwd(), result.name)}`);
      if (details.length > 0) console.error(details.join("\n"));
      else console.error("[web-budget] Vitest reported no assertion details");
    }
    process.exitCode = exitCode || 1;
  }
  if (elapsedMs > suiteLimitMs) {
    console.error(`[web-budget] suite exceeded ${(suiteLimitMs / 1_000).toFixed(0)}s: ${(elapsedMs / 1_000).toFixed(2)}s`);
    process.exitCode = 1;
  }
  for (const result of slowFiles) {
    console.error(`[web-budget] file exceeded ${(fileLimitMs / 1_000).toFixed(0)}s: ${result.name} (${(result.durationMs / 1_000).toFixed(2)}s)`);
    process.exitCode = 1;
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
