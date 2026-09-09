import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";
import sharp from "sharp";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="1"/></filter></defs><rect width="240" height="100" fill="url(#paint)" filter="url(#blur)"/><foreignObject x="10" y="10" width="200" height="60"><div xmlns="http://www.w3.org/1999/xhtml">完整 SVG</div></foreignObject><circle cx="30" cy="70" r="8"><animate attributeName="cx" values="30;200;30" dur="2s" repeatCount="indefinite"/></circle></svg>';
const response = '<p style="color: #ffbb00">❤️ 💛 <span title="单独爱心">❤</span> 👩🏽‍💻 123</p>\n\n```html\n<!doctype html><html><head><title>Test</title></head><body><button id="counter">0</button><p id="isolation"></p><script src="https://preview.example.test/library.js"></script><script type="module">document.body.dataset.module="ready"</script></body></html>\n```\n```css\nbody { background: rgb(240, 250, 255) } button { color: rgb(255, 0, 0); font-size: 24px }\n```\n```js\nlet count=0; document.querySelector("button").onclick=()=>{document.querySelector("button").textContent=String(++count)}; try { parent.document.body.dataset.leaked="yes" } catch { document.querySelector("#isolation").textContent="已隔离" }\n```\n\n下面是 SVG：\n\n```svg\n' + svg + '\n```\n\n末尾正文';

test("HTML 脚本和 SVG 在隔离预览中运行，emoji 保留原色，离线可重新打开", async ({ page, request, context }, info) => {
  const provider = await startMockProvider({ responseText: response, firstResponseDelayMs: 300 });
  const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Rich preview", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
  const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("预览助手", model.id));
  const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "展示预览" });
  try {
    await page.route("https://preview.example.test/library.js", (route) => route.fulfill({ contentType: "text/javascript", body: 'document.body.dataset.external="loaded"' }));
    const runner = await request.get(`${APP_URL}/render-frame.html`);
    const validated = await request.get(`${APP_URL}/render-frame.html`, { headers: { "if-none-match": runner.headers().etag! } });
    expect(validated.status()).toBe(304);
    expect(validated.headers()["content-security-policy"]).toBe(runner.headers()["content-security-policy"]);
    const shell = await request.get(APP_URL);
    expect(shell.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(shell.headers()["content-security-policy"]).not.toContain("'unsafe-eval'");
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    await expect(page.locator('.msg[data-role="assistant"]').last()).toContainText("末尾正文");
    const html = page.frameLocator('iframe[title="HTML 预览"]').frameLocator('iframe[title="渲染内容"]');
    const vector = page.frameLocator('iframe[title="SVG 预览"]').frameLocator('iframe[title="渲染内容"]');
    await expect(html.getByText("已隔离")).toBeVisible();
    await expect(html.locator("body")).toHaveAttribute("data-external", "loaded");
    await expect(html.locator("body")).toHaveAttribute("data-module", "ready");
    await expect(html.getByRole("button", { name: "0", exact: true })).toHaveCSS("color", "rgb(255, 0, 0)");
    await html.getByRole("button", { name: "0", exact: true }).click();
    await expect(html.getByRole("button", { name: "1", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-leaked");
    await expect(vector.getByText("完整 SVG")).toBeVisible();
    await expect(vector.locator("linearGradient")).toHaveCount(1);
    await expect(vector.locator("animate")).toHaveCount(1);
    await expect(page.locator(".rich-preview-status")).toHaveCount(0);
    await expect(page.frameLocator('iframe[title="HTML 预览"]').locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    const emoji = page.locator(".markdown p").filter({ hasText: "❤️ 💛 ❤" });
    await expect(emoji).toBeVisible();
    const capture = await page.getByTitle("单独爱心", { exact: true }).screenshot();
    await sharp(capture).toFile(info.outputPath("emoji.png"));
    const { data, info: pixels } = await sharp(capture).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let red = 0, yellow = 0;
    for (let i = 0; i < data.length; i += pixels.channels) {
      if (data[i]! > 160 && data[i + 1]! < 110 && data[i + 2]! < 110) red++;
      if (data[i]! > 160 && data[i + 1]! > 130 && data[i + 2]! < 100) yellow++;
    }
    expect(red).toBeGreaterThan(15); expect(yellow).toBeLessThan(red);
    const preview = page.getByRole("region", { name: "SVG 预览", exact: true });
    await preview.getByRole("button", { name: "查看源码" }).click();
    await expect(preview.locator("pre code")).toHaveText(svg);
    const [download] = await Promise.all([page.waitForEvent("download"), preview.getByRole("button", { name: "下载", exact: true }).click()]);
    expect(download.suggestedFilename()).toBe("preview.svg");
    await preview.getByRole("button", { name: "展开", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await preview.getByRole("button", { name: "收起", exact: true }).click();
    // An unrelated draft update must not restart the embedded program.
    await page.getByLabel("输入消息", { exact: true }).fill("预览期间的草稿");
    await expect(html.getByRole("button", { name: "1", exact: true })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(`${APP_URL}/settings/general`);
    await expect(page.getByLabel("离线记录", { exact: true })).toContainText("最后完整同步");
    await page.unroute("https://preview.example.test/library.js");
    await context.setOffline(true);
    await page.goto(`${APP_URL}/c/${started.conversation.id}`);
    await expect(page.frameLocator('iframe[title="HTML 预览"]').frameLocator('iframe[title="渲染内容"]').getByRole("button", { name: "0", exact: true })).toBeVisible();
    await expect(page.frameLocator('iframe[title="SVG 预览"]').frameLocator('iframe[title="渲染内容"]').getByText("完整 SVG")).toBeVisible();
  } finally {
    await context.setOffline(false); await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${started.conversation.id}`);
    await provider.close();
  }
});
