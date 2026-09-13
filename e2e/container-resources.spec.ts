import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  const cn = locale === "zh-CN";
  test("selects a download node, resumes a large offline file and selects plugin software for an Agent", async ({ page, request }) => {
    const directory = await mkdtemp(join(tmpdir(), "llm-chat-resource-e2e-"));
    const id = `software-${Date.now()}`;
    const data = Buffer.alloc(8 * 1024 * 1024 + 17, 65);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const file = { name: "offline-software.bin", size: data.length, sha256, url: "https://example.org/offline-software.bin" };
    await writeFile(join(directory, "plugin.json"), JSON.stringify({ id, name: "Offline software", apiVersion: 1, version: "1", containerResources: [
      { id: "extra", name: "Extra software", version: "1", variants: [{ platform: "linux/amd64", distro: "alpine-3.24", files: [file], install: "true", verify: "true" }] }
    ] }));
    const before = await api(request, APP_URL, "GET", "/api/container-resources");
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Alpine preload"));
    try {
      await api(request, APP_URL, "POST", "/api/plugins/install", { sourcePath: directory });
      // The first chunk was uploaded before the browser resumed the same file.
      const upload = await api(request, APP_URL, "POST", "/api/container-resources/uploads", { name: file.name, size: file.size });
      const chunk = await request.put(`${APP_URL}/api/container-resources/uploads/${upload.id}?offset=0`, {
        headers: { "content-type": "application/octet-stream", "x-llm-chat-request": "1" }, data: data.subarray(0, 8 * 1024 * 1024)
      });
      expect(chunk.status()).toBe(200);
      await page.goto("/settings/container-resources");
      await page.getByLabel(cn ? "下载节点" : "Download node", { exact: true }).selectOption("official");
      await expect.poll(async () => (await api(request, APP_URL, "GET", "/api/container-resources")).node).toBe("official");
      const uploads: string[] = [];
      page.on("request", request => { if (request.method() === "PUT" && request.url().includes("/uploads/")) uploads.push(request.url()); });
      await page.getByLabel(cn ? "上传离线资源" : "Upload offline resources", { exact: true }).setInputFiles({ name: file.name, mimeType: "application/octet-stream", buffer: data });
      await expect.poll(async () => {
        const catalog = await api(request, APP_URL, "GET", "/api/container-resources");
        return catalog.resources.find((r: { id: string }) => r.id === `plugin:${id}:extra`)?.files.find((f: { sha256: string }) => f.sha256 === sha256)?.cached;
      }).toBe(true);
      expect(uploads).toHaveLength(1); expect(uploads[0]).toContain("offset=8388608");
      await page.getByText(cn ? "手动下载文件清单" : "Manual download files", { exact: false }).last().click();
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
