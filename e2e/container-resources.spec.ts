import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  const cn = locale === "zh-CN";
  test("selects a download node and Agent preloads without offline import or export", async ({ page, request }) => {
    const directory = await mkdtemp(join(tmpdir(), "llm-chat-resource-e2e-"));
    const id = `software-${Date.now()}`;
    const data = Buffer.from("extra software");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const file = { name: "extra-software.bin", size: data.length, sha256, url: "https://example.org/extra-software.bin" };
    await writeFile(join(directory, "plugin.json"), JSON.stringify({ id, name: "Extra software plugin", apiVersion: 1, version: "1", containerResources: [
      { id: "extra", name: "Extra software", version: "1", variants: [{ platform: "linux/amd64", distro: "alpine-3.24", files: [file], install: "true", verify: "true" }] }
    ] }));
    const before = await api(request, APP_URL, "GET", "/api/container-resources");
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Alpine preload"));
    try {
      await api(request, APP_URL, "POST", "/api/plugins/install", { sourcePath: directory });
      await page.goto("/settings/container-resources");
      await page.getByLabel(cn ? "下载节点" : "Download node", { exact: true }).selectOption("official");
      await expect.poll(async () => (await api(request, APP_URL, "GET", "/api/container-resources")).node).toBe("official");
      await expect(page.locator('input[type="file"]')).toHaveCount(0);
      await expect(page.getByText(cn ? "导出离线包" : "Export offline bundle", { exact: true })).toHaveCount(0);
      for (const [method, path] of [
        ["GET", "/api/container-resources/bundle?ids=builtin:tools"],
        ["POST", "/api/container-resources/uploads"],
        ["PUT", "/api/container-resources/uploads/old?offset=0"],
        ["POST", "/api/container-resources/uploads/old/complete"]
      ]) {
        const response = await request.fetch(`${APP_URL}${path}`, { method, headers: { "x-llm-chat-request": "1" } });
        expect(response.status()).toBe(404);
      }
      await page.getByText(cn ? "资源文件" : "Resource files", { exact: false }).last().click();
      await expect(page.getByRole("link", { name: file.name, exact: true })).toHaveAttribute("href", file.url);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      await page.getByLabel(cn ? "执行环境" : "Execution environment", { exact: true }).selectOption("container");
      await expect(page.getByLabel(cn ? "镜像" : "Image", { exact: true })).toHaveValue("alpine");
      await expect(page.getByLabel(cn ? "常用工具" : "Common tools", { exact: true })).toBeChecked();
      await expect(page.getByLabel("Extra software", { exact: true })).not.toBeChecked();
      await page.getByLabel("Extra software", { exact: true }).check();
      await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
      await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
      const saved = await api(request, APP_URL, "GET", `/api/agents/${agent.id}`);
      expect(saved.execution.environment.preloadResourceIds).toEqual(["builtin:tools", `plugin:${id}:extra`]);
      await page.reload(); await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
      await expect(page.getByLabel("Extra software", { exact: true })).toBeChecked();
    } finally {
      await page.goto("about:blank");
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
      await api(request, APP_URL, "DELETE", `/api/plugins/${id}`);
      await api(request, APP_URL, "PUT", "/api/container-resources/settings", { node: before.node });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
