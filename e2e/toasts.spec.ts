import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";

test.use({ serviceWorkers: "block" });

async function checkPosition(page: import("@playwright/test").Page) {
  const main = (await page.locator(".workspace-main").boundingBox())!;
  const stack = (await page.locator(".toast-stack").boundingBox())!;
  expect(stack.x).toBeGreaterThanOrEqual(main.x + 11);
  expect(stack.x + stack.width).toBeLessThanOrEqual(main.x + main.width - 11);
  expect(stack.width).toBeLessThanOrEqual(421);
  expect(Math.abs(stack.x + stack.width / 2 - main.x - main.width / 2)).toBeLessThan(2);
  const tabs = await page.getByRole("tablist", { name: "设置分区" }).boundingBox();
  if (tabs) expect(stack.y).toBeGreaterThanOrEqual(tabs.y + tabs.height + 7);
}

test("notifications stay within the main column and support grouping, details, closing and overlays", async ({ page, request }, testInfo) => {
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "提示布局测试", baseUrl: "https://example.invalid", secretHeaders: {} });
  let message = "连接失败，请稍后重试";
  await page.route(`**/api/connections/${connection.id}/test`, route => route.fulfill({ status: 503, json: { error: { code: "test_failure", message } } }));
  await page.goto("/settings/connections");
  await page.getByRole("combobox", { name: "提供商连接" }).selectOption(connection.id);
  const trigger = page.getByRole("button", { name: "测试连接", exact: true });
  const stack = page.locator(".toast-stack");
  await trigger.click();
  await expect(stack.getByRole("alert")).toHaveText(/连接失败/);
  await checkPosition(page);
  await trigger.click();
  await expect(stack.getByLabel("重复 2 次")).toHaveText("×2");
  await expect(stack.getByRole("alert")).toHaveCount(1);
  message = "另一条错误";
  await trigger.click();
  await stack.getByRole("button", { name: "另有 1 条" }).click();
  await expect(stack.getByRole("alert")).toHaveCount(2);
  await stack.getByRole("button", { name: "收起提示列表" }).click();
  await expect(stack.getByRole("alert")).toHaveCount(1);
  await stack.getByRole("button", { name: "关闭提示" }).click();
  await expect(stack.getByRole("alert")).toHaveText(/连接失败/);
  message = "很长的错误详情，包含需要复制和阅读的内容。".repeat(45);
  await trigger.click();
  await stack.getByRole("button", { name: "展开详情" }).click();
  await expect(stack.locator('.toast-message[data-expanded="true"]')).toHaveText(message);
  const height = await stack.evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(page.viewportSize()!.height * .35 + 1);
  if (testInfo.project.name !== "mobile-chromium") {
    await page.getByRole("button", { name: "折叠会话栏" }).click();
    await expect(page.locator('.workspace-sidebar:not([aria-hidden="true"])')).toHaveAttribute("data-compact", "true");
    await expect.poll(async () => {
      const main = (await page.locator(".workspace-main").boundingBox())!;
      const toast = (await stack.boundingBox())!;
      return Math.abs(toast.x + toast.width / 2 - main.x - main.width / 2);
    }).toBeLessThan(2);
    await page.setViewportSize({ width: 900, height: 520 });
    await checkPosition(page);
  } else {
    await openDrawerIfNeeded(page);
    await expect(stack).toBeHidden();
    await page.locator('.workspace-sidebar:visible').getByRole("button", { name: "关闭导航" }).click();
    await expect(stack).toBeVisible();
  }
  const newConnection = page.getByRole("button", { name: "新建连接", exact: true });
  await newConnection.focus();
  await newConnection.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(stack).toHaveAttribute("inert");
  await page.keyboard.press("Escape");
  await expect(stack).not.toHaveAttribute("inert");
  await page.screenshot({ path: `/tmp/llm-ui-artifacts/toasts-${testInfo.project.name}.png` });
});

test("reading mode preserves pending errors until the interface returns", async ({ page, request }) => {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("提示阅读测试"));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "提示阅读会话" });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "阅读提示连接", baseUrl: "https://example.invalid", secretHeaders: {} });
  await page.route(`**/api/connections/${connection.id}/test`, route => route.fulfill({ status: 503, json: { error: { code: "test_failure", message: "阅读期间保留的错误提示" } } }));
  await page.goto("/settings/connections");
  await page.getByRole("combobox", { name: "提供商连接" }).selectOption(connection.id);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await openDrawerIfNeeded(page);
  await page.locator('.workspace-sidebar:visible').getByRole("link", { name: /提示阅读会话/ }).click();
  await page.getByRole("button", { name: "阅读模式", exact: true }).click();
  await expect(page.locator(".toast-stack")).toBeHidden();
  await page.waitForTimeout(5_200);
  await page.keyboard.press("q");
  await expect(page.locator(".toast-stack").getByRole("alert")).toHaveText("阅读期间保留的错误提示");
});
