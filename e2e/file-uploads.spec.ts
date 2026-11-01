import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";

// Network interception must reach the page request rather than a service worker fetch.
test.use({ serviceWorkers: "block" });

for (const kind of ["image", "file"] as const) {
  test(`${kind === "image" ? "图片" : "小文件"}上传失败后可直接重试并清理本地暂存`, async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem("llm-chat.requests.v1", JSON.stringify({ maxRetries: 0 })));
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`cache-${Date.now()}`));
    const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
    let fail = true;
    await page.route("**/api/file-uploads", (route) => fail ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "try again" } } }) : route.continue());
    try {
      await page.goto(`${APP_URL}/c/${conversation.id}`);
      const name = kind === "image" ? "cached.png" : "cached.txt";
      const buffer = kind === "image" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") : Buffer.from("cached attachment");
      await page.getByLabel(kind === "image" ? "上传图片" : "上传文件", { exact: true }).setInputFiles({ name, mimeType: kind === "image" ? "image/png" : "text/plain", buffer });
      const row = page.locator(".composer .file-upload-row");
      await expect(row.getByRole("button", { name: "重试", exact: true })).toBeVisible();
      const storedCount = () => page.evaluate(() => new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("llm-chat-uploads");
        request.onsuccess = () => {
          const db = request.result; const count = db.transaction("files").objectStore("files").count();
          count.onsuccess = () => { resolve(count.result); db.close(); }; count.onerror = () => reject(count.error);
        };
        request.onerror = () => reject(request.error);
      }));
      expect(await storedCount()).toBe(1);
      fail = false;
      await row.getByRole("button", { name: "重试", exact: true }).click();
      await expect(page.getByLabel("待发送附件")).toContainText(name);
      await expect.poll(storedCount).toBe(0);
    } finally {
      await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
      await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    }
  });
}

test("小文件刷新后自动从确认的分块续传，无需重新选择", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("llm-chat.requests.v1", JSON.stringify({ maxRetries: 0 })));
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`resume-cache-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  let fail = true;
  await page.route("**/api/file-uploads/*?offset=*", (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return fail && offset >= 4 * 1024 ** 2 ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "try again" } } }) : route.continue();
  });
  try {
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await page.getByLabel("输入消息").fill("保留这份草稿");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "cached-chunks.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(5 * 1024 ** 2) });
    await expect(page.locator(".composer .file-upload-row").getByRole("button", { name: "重试", exact: true })).toBeVisible();
    let resumedOffset: number | undefined;
    page.on("request", (request) => {
      if (!fail && request.method() === "PATCH" && request.url().includes("/api/file-uploads/") && resumedOffset === undefined) resumedOffset = Number(new URL(request.url()).searchParams.get("offset"));
    });
    fail = false; await page.reload();
    await expect(page.getByLabel("待发送附件")).toContainText("cached-chunks.bin", { timeout: 45_000 });
    await expect(page.getByLabel("输入消息")).toHaveValue("保留这份草稿");
    expect(resumedOffset).toBe(4 * 1024 ** 2);
  } finally {
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});

test("关闭页面后重新打开仍能自动恢复小文件和原草稿", async ({ page, context, request }) => {
  await page.addInitScript(() => localStorage.setItem("llm-chat.requests.v1", JSON.stringify({ maxRetries: 0 })));
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`reopen-cache-${Date.now()}`));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  await page.route("**/api/file-uploads", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "try again" } } }));
  try {
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    await page.getByLabel("输入消息").fill("关闭后保留");
    await page.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "reopen.txt", mimeType: "text/plain", buffer: Buffer.from("saved before closing") });
    await expect(page.locator(".composer .file-upload-row").getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(`${APP_URL}/c/${conversation.id}`);
    await expect(reopened.getByLabel("待发送附件")).toContainText("reopen.txt", { timeout: 45_000 });
    await expect(reopened.getByLabel("输入消息")).toHaveValue("关闭后保留");
  } finally {
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});

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
    const draft = await page.evaluate((id) => JSON.parse(localStorage.getItem(`llm-chat.composer.v1.${id}`)!), conversation.id);
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
