import { expect, test } from "@playwright/test";
import { openChat, recordPageErrors } from "./helpers";

test("production shell, assets, manifest, and chat controls are healthy", async ({ page, request }) => {
  const errors = recordPageErrors(page);
  const { conversationId } = await openChat(page, request);

  const documentResponse = await request.get(`/c/${conversationId}`);
  expect(documentResponse.status()).toBe(200);
  expect(documentResponse.headers()["content-type"]).toContain("text/html");
  const html = await documentResponse.text();
  const scriptPath = html.match(/<script[^>]+src="([^"]*\/assets\/index-[A-Za-z0-9_-]{8,}\.js)"/)?.[1];
  expect(scriptPath, "built index.html must reference a hashed entry script").toBeTruthy();

  const scriptResponse = await request.get(scriptPath!);
  expect(scriptResponse.status()).toBe(200);
  expect(scriptResponse.headers()["content-type"]).toMatch(/(?:application|text)\/javascript/);
  expect((await scriptResponse.text()).slice(0, 80)).not.toContain("<!doctype html>");

  const staleAsset = await request.get("/assets/index-e2e-stale-00000000.js");
  expect(staleAsset.status()).toBe(404);
  expect(staleAsset.headers()["content-type"]).toContain("text/plain");
  expect(await staleAsset.text()).toBe("Asset not found");

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const manifestResponse = await request.get(manifestHref!);
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json() as { name: string; icons: Array<{ src: string }> };
  expect(manifest.name).toBe("llm-chat");
  expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()["content-type"], icon.src).toBe("image/png");
  }

  const header = page.locator(".chat-header");
  await expect(header.getByRole("button", { name: "E2E layout conversation" })).toBeVisible();
  await expect(header.getByLabel("选择 Agent")).toBeVisible();
  await expect(header.getByRole("button", { name: "后台任务", exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "会话操作" })).toBeVisible();
  await expect(page.getByPlaceholder("输入消息")).toBeEnabled();
  await expect(page.locator(".composer-rail").getByLabel("选择 Agent")).toBeVisible();
  const modelButton = page.locator(".composer-rail").getByRole("button", { name: "选择模型" });
  await expect(modelButton).toBeVisible();
  await expect(modelButton).toContainText("E2E Model");
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
});
