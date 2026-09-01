import { expect, test } from "@playwright/test";
import { readSupervisorState } from "./helpers";

test("password login works in every supported browser", async ({ page, context }) => {
  const state = await readSupervisorState();
  await page.goto(state.authUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "进入 llm-chat" })).toBeVisible();
  await page.getByLabel("密码").fill(state.initialPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("先添加一个模型连接", { exact: true })).toBeVisible({ timeout: 20_000 });

  const cookies = await context.cookies(state.authUrl);
  expect(cookies.some((cookie) => cookie.name === "llm_chat_session" && cookie.httpOnly)).toBe(true);
  const bootstrap = await context.request.get(`${state.authUrl}/api/bootstrap`);
  expect(bootstrap.status()).toBe(200);
  await expect(page.locator("#root")).not.toBeEmpty();
});
