import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openMessageActions } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";

test("回复密度、按需操作和处理展开在宽窄屏保持稳定", async ({ page, request }, testInfo) => {
  const provider = await startMockProvider({ responseText: "你好！有需要尽管说。" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Reply layout", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { contextWindow: 128000 });
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("回复布局助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "你好" });
  try {
    await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    const reply = page.locator('.msg[data-role="assistant"]').last();
    await expect(reply.getByText("你好！有需要尽管说。")).toBeVisible();
    await expect(page.locator(".toast.error")).toHaveCount(0);
    await reply.evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
    const mobile = testInfo.project.name === "mobile-chromium";
    for (const width of mobile ? [360, 390] : [768, 1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        await page.mouse.move(0, 0);
        await expect(reply.locator(".process-disclosure")).not.toHaveAttribute("open");
        await expect(reply.locator(".msg-head")).toHaveCount(0);
        const before = await reply.boundingBox();
        expect(before!.height).toBeLessThanOrEqual(112);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`reply-${width}-${theme}.png`) });
        if (!mobile) {
          await expect(reply.locator(".reply-inline")).toHaveCSS("opacity", "0");
          await reply.hover();
          await expect(reply.locator(".reply-inline")).toHaveCSS("opacity", "1");
          expect(await reply.boundingBox()).toEqual(before);
          await page.screenshot({ path: testInfo.outputPath(`reply-${width}-${theme}-details.png`) });
          await reply.getByRole("button", { name: "复制回答", exact: true }).focus();
          await page.mouse.move(0, 0);
          await expect(reply.locator(".reply-inline")).toHaveCSS("opacity", "1");
          await page.getByLabel("输入消息").focus();
        } else {
          await openMessageActions(page, reply);
          const popover = page.getByRole("dialog", { name: "消息详情与操作" });
          await expect(popover).toContainText("回复布局助手");
          await page.screenshot({ path: testInfo.outputPath(`reply-${width}-${theme}-details.png`) });
          expect(await reply.boundingBox()).toEqual(before);
          await page.keyboard.press("Escape");
          await expect(popover).toHaveCount(0);
          await expect(reply.getByRole("button", { name: "消息更多操作" })).toBeFocused();
        }
      }
    }
    await reply.locator(".process-disclosure > summary").click();
    await expect(reply.getByText("先想一下。")).toBeVisible();
    await reply.locator(".process-disclosure > summary").click();
    await openMessageActions(page, reply);
    await page.getByRole("button", { name: "检查生成", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "检查器" });
    await expect(inspector).toContainText("回复布局助手");
    await expect(inspector).toContainText("18 tokens");
  } finally {
    await api(request, APP_URL, "DELETE", `/api/conversations/${started.conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
    await provider.close();
  }
});
