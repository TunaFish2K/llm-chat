import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { imageRetryMessages } from "../apps/web/test/image-tool-fixtures";

// Route fixtures must reach Playwright on reload instead of bypassing it through the worker.
test.use({ serviceWorkers: "block" });

test("图片任务按调用顺序显示，折叠和刷新后不堆积到末尾", async ({ page, request }, testInfo) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("图片时间线"));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
  const messages = imageRetryMessages(conversation.id);
  await page.route("**/api/bootstrap?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), messages } });
  });
  await page.route(`**/api/conversations/${conversation.id}/messages`, (route) => route.fulfill({ json: messages }));
  await page.route("**/api/files/beach", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=", "base64") }));
  try {
    await page.goto(`${APP_URL}/c/${conversation.id}`);
    const results = page.locator(".image-tool-result");
    for (let load = 0; load < 2; load++) {
      await expect(results).toHaveCount(3);
      await expect(page.locator(".chat-thread > .msg")).toHaveCount(2);
      await expect(results.nth(0)).toContainText("Upstream request failed (1)");
      await expect(results.nth(1)).toContainText("Upstream request failed (2)");
      await expect(results.nth(2).getByRole("img", { name: "beach.png" })).toBeVisible();
      const order = await page.locator(".stream").evaluate((stream) => Array.from(stream.children)
        .filter((node) => node.matches(".markdown, .image-tool-results"))
        .map((node) => node.querySelector("[data-image-job-id]")?.getAttribute("data-image-job-id") ?? node.textContent?.trim()));
      expect(order).toEqual(["开始画图", "job-1", "第一次重试", "job-2", "第二次重试", "job-3", "海滩已画好"]);
      const disclosures = page.locator(".process-disclosure");
      for (const disclosure of await disclosures.all()) {
        await expect(disclosure).not.toHaveAttribute("open", "");
        await disclosure.locator(":scope > summary").click();
        await disclosure.locator(".tool-call > summary").click();
      }
      await expect(page.getByRole("img", { name: "beach.png" })).toHaveCount(1);
      for (const disclosure of await disclosures.all()) await disclosure.locator(":scope > summary").click();
      for (const result of await results.all()) await expect(result).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (load === 0) await page.reload();
    }
    await page.screenshot({ path: testInfo.outputPath("image-timeline.png"), fullPage: true });
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
  }
});
