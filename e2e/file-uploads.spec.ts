import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";

// Network interception must reach the page request rather than a service worker fetch.
test.use({ serviceWorkers: "block" });

test("大文件在切页后完成并回填原草稿，刷新后从已确认分块续传", async ({ page, request }) => {
  test.setTimeout(120_000);
  const dir = await mkdtemp(join(tmpdir(), "llm-chat-upload-e2e-"));
  const path = join(dir, "large-data.bin");
  const file = await open(path, "w"); await file.truncate(65 * 1024 ** 2); await file.close();
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`upload-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: `upload-${Date.now()}` });
  let release!: () => void;
  let blocked = false;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.route("**/api/file-uploads/*?offset=*", async (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
      if (offset >= 4 * 1024 ** 2 && !blocked) { blocked = true; await paused; }
      await route.continue().catch(() => {});
    });
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await page.getByLabel("输入消息").fill("分析这个数据文件");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles(path);
    await expect.poll(() => blocked).toBe(true);
    await openDrawerIfNeeded(page);
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator(".global-file-uploads")).toBeVisible();
    // Navigation has not aborted the transfer. Refresh destroys the File handle but keeps the receipt.
    await page.reload(); release();
    await page.unroute("**/api/file-uploads/*?offset=*");
    await page.locator(".global-file-uploads summary").click();
    await expect(page.getByText("请选择原文件继续上传", { exact: false })).toBeVisible();
    let firstOffset: number | undefined;
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/api/file-uploads/") && firstOffset === undefined) firstOffset = Number(new URL(request.url()).searchParams.get("offset"));
    });
    await page.getByLabel("选择原文件: large-data.bin", { exact: true }).setInputFiles(path);
    await expect(page.locator(".global-file-uploads")).toHaveCount(0, { timeout: 60_000 });
    expect(firstOffset).toBeGreaterThanOrEqual(4 * 1024 ** 2);
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await expect(page.getByLabel("输入消息")).toHaveValue("分析这个数据文件");
    await expect(page.getByLabel("待发送附件")).toContainText("large-data.bin");
    const draft = await page.evaluate((id) => JSON.parse(sessionStorage.getItem(`llm-chat.composer.v1.${id}`)!), conversation.id);
    expect(draft.attachments[0].byteSize).toBe(65 * 1024 ** 2);
    const range = await request.get(`${APP_URL}${draft.attachments[0].url}`, { headers: { range: "bytes=68157435-68157439" } });
    expect(range.status()).toBe(206); expect((await range.body()).length).toBe(5);
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await rm(dir, { recursive: true, force: true });
  }
});
