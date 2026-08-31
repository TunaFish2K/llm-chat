import { expect, test } from "@playwright/test";
import { expectNoOverlap, openChat } from "./helpers";

test("desktop and mobile chat controls remain distinct and interactable", async ({ page, request }, testInfo) => {
  test.skip(!["chromium", "mobile-chromium"].includes(testInfo.project.name), "Chromium desktop and mobile own layout geometry");
  await openChat(page, request);

  const header = page.locator(".chat-header");
  const title = header.locator(".conversation-title-slot");
  const agent = header.locator(".agent-selector");
  const spacer = header.locator(".header-spacer");
  const taskButton = header.getByRole("button", { name: "后台任务", exact: true });
  const moreButton = header.getByRole("button", { name: "会话操作" });
  const spacerBox = await spacer.boundingBox();
  expect(spacerBox).not.toBeNull();
  expect(spacerBox!.width).toBeGreaterThanOrEqual(0);

  await expectNoOverlap(title, agent, "title and Agent selector");
  await expectNoOverlap(agent, spacer, "Agent selector and spacer");
  await expectNoOverlap(spacer, taskButton, "spacer and background-task button");
  await expectNoOverlap(taskButton, moreButton, "background-task and more buttons");

  const minimumTarget = testInfo.project.name === "mobile-chromium" ? 44 : 40;
  for (const button of [taskButton, moreButton]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(minimumTarget);
    expect(box!.height).toBeGreaterThanOrEqual(minimumTarget);
  }

  await taskButton.click();
  const taskDrawer = page.locator(".ant-drawer");
  const taskDrawerTitle = taskDrawer.getByText("后台任务", { exact: true });
  await expect(taskDrawerTitle).toBeVisible();
  await taskDrawer.locator(".ant-drawer-close").click();
  await expect(taskDrawerTitle).toBeHidden();

  await moreButton.click();
  await expect(page.getByText("会话执行设置", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const composer = page.locator(".composer-rail");
  const composerAgent = composer.getByLabel("选择 Agent");
  const model = composer.getByRole("button", { name: "选择模型" });
  const workspace = composer.getByRole("button", { name: "选择工作目录" });
  await expectNoOverlap(composerAgent, model, "composer Agent and model controls");
  await expectNoOverlap(model, workspace, "composer model and workspace controls");

  const input = page.getByPlaceholder("输入消息");
  await input.fill("layout interaction check");
  await expect(input).toHaveValue("layout interaction check");
});
