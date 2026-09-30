import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";
import type { MessageDto } from "@llm-chat/contracts";

test.use({ serviceWorkers: "block" });

test("千条变高消息仅挂载视口，能阅读开头并返回最新消息", async ({ page, request }, testInfo) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("虚拟历史"));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "变高历史" });
  const messages: MessageDto[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `variable-${index}`, ordinal: index + 1, role: "user", text: `历史记录 ${index}\n${"不同行高的正文。\n".repeat(index % 9)}`,
    generatedModel: null, attachments: [], activeGenerationId: null, generations: [], greeting: null, createdAt: index + 1
  }));
  await page.addInitScript(() => localStorage.setItem("llm-chat.offline-enabled", "false"));
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), messages } });
  });
  await page.route(`**/api/conversations/${conversation.id}/messages`, route => route.fulfill({ json: messages }));
  await page.goto(`${APP_URL}/c/${conversation.id}`);
  const scroller = page.getByLabel("消息列表", { exact: true });
  await expect(page.locator('.message-virtual-row[data-index="999"]')).toBeVisible();
  await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
  expect(await page.locator('.msg').count()).toBeLessThan(24);
  await scroller.hover({ position: { x: 5, y: 5 } });
  await page.mouse.wheel(0, -1_000_000);
  await expect(page.locator('.message-virtual-row[data-index="0"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.locator('.message-virtual-row[data-index="0"]')).toBeVisible();
  expect(await page.locator('.msg').count()).toBeLessThan(24);
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect(page.locator('.message-virtual-row[data-index="999"]')).toBeVisible();
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('virtual-history.png') });
});

test("不完整缓存和后台分支更新下连续切换 100 次，始终停在最后选择的会话", async ({ page, request, isMobile }) => {
  test.setTimeout(120_000);
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("导航稳定性"));
  const old = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "旧会话" });
  const next = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "新会话" });
  const origin = { conversationId: "missing-parent", messageId: null, messageOrdinal: null, mode: "continue", greetingIndex: null, sourceGreetingIndex: null };
  const conversations = [{ ...old, activeBranchId: next.id, forkedFrom: origin }, { ...next, activeBranchId: old.id, forkedFrom: origin }];
  await page.addInitScript(() => localStorage.setItem("llm-chat.offline-enabled", "false"));
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), conversations, messages: [] } });
  });
  await page.route("**/api/conversations", route => route.request().method() === "GET" ? route.fulfill({ json: conversations }) : route.continue());
  await page.goto(`${APP_URL}/c/${old.id}`);
  await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
  const click = async (selector: string) => {
    const link = page.locator(selector).first();
    await expect(link).toBeVisible();
    const point = await link.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    await page.mouse.click(point.x, point.y);
  };
  for (let index = 0; index < 100; index++) {
    const destination = index % 2 ? old : next;
    if (isMobile) {
      await click('.conversation-header .shell-control');
      await page.waitForFunction(() => {
        const panel = document.querySelector('.drawer-panel');
        return panel && getComputedStyle(panel).transform === 'none';
      });
    }
    await click(`.conversation-row a[href="/c/${destination.id}"]`);
    await expect(page).toHaveURL(`${APP_URL}/c/${destination.id}`);
    await page.waitForFunction(() => !document.querySelector('.mobile-drawer'));
    await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
    if (index % 10 === 0) await api(request, APP_URL, "PATCH", `/api/conversations/${old.id}`, { title: `后台更新 ${index}` });
  }
  await page.getByLabel("输入消息", { exact: true }).fill("最后选择的会话草稿");
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(`${APP_URL}/c/${old.id}`);
  await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("最后选择的会话草稿");
});

test("离开新会话后返回，迟到的确认不跳转或覆盖当前草稿", async ({ page, request }, testInfo) => {
  const provider = await startMockProvider({ responseText: "迟到确认" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Late acceptance", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("迟到确认助手", model.id));
    const old = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "已有会话" });
    await api(request, APP_URL, "PATCH", "/api/settings", { lastAgentId: agent.id });
    await page.route("**/api/conversations/start", async route => { await gate; await route.continue().catch(() => {}); });
    await page.goto(APP_URL!);
    await page.getByLabel("输入消息", { exact: true }).fill("等待确认的旧提交");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await openDrawerIfNeeded(page);
    await page.locator(`.conversation-row a[href="/c/${old.id}"]`).click();
    await expect(page).toHaveURL(`${APP_URL}/c/${old.id}`);
    await expect(page.locator(".mobile-drawer")).toHaveCount(0);
    await openDrawerIfNeeded(page);
    await page.getByRole("button", { name: "新会话", exact: true }).click();
    await expect(page).toHaveURL(`${APP_URL}/`);
    await page.getByLabel("输入消息", { exact: true }).fill("当前新草稿不能被覆盖");
    release();
    await expect.poll(async () => (await api(request, APP_URL, "GET", "/api/conversations")).filter((item: { agentId: string }) => item.agentId === agent.id).length).toBe(2);
    await expect(page.locator(".pending-message")).toHaveCount(0);
    await expect(page).toHaveURL(`${APP_URL}/`);
    await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("当前新草稿不能被覆盖");
    await page.screenshot({ path: testInfo.outputPath("stable-new-chat.png") });
  } finally { release(); await page.goto("about:blank").catch(() => {}); await provider.close(); }
});
