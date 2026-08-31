import { expect, test } from "@playwright/test";
import { readSupervisorState } from "./helpers";

test("Chromium registers the first Passkey through the real bootstrap flow", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "CDP virtual WebAuthn is Chromium-only");
  const state = await readSupervisorState();
  const client = await context.newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });

  try {
    await page.goto(state.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "信任首台设备" })).toBeVisible();
    await page.getByLabel("设备名称").fill("E2E virtual Passkey");
    await page.getByRole("button", { name: "创建 Passkey" }).click();
    await expect(page.getByText("先添加一个模型连接", { exact: true })).toBeVisible({ timeout: 20_000 });

    const cookies = await context.cookies(state.authUrl);
    expect(cookies.some((cookie) => cookie.name === "llm_chat_session" && cookie.httpOnly)).toBe(true);
    const bootstrap = await context.request.get(`${state.authUrl}/api/bootstrap`);
    expect(bootstrap.status()).toBe(200);
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await client.send("WebAuthn.disable");
  }
});

test("Firefox and WebKit show a supported or explicit degraded pairing state", async ({ page }, testInfo) => {
  test.skip(!["firefox", "webkit"].includes(testInfo.project.name), "Alternative desktop engines own this coverage");
  const state = await readSupervisorState();
  await page.goto(state.bootstrapUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "信任首台设备" })).toBeVisible();

  const supported = await page.evaluate(() => window.isSecureContext
    && "PublicKeyCredential" in window
    && Boolean(navigator.credentials));
  if (supported) {
    await expect(page.getByRole("button", { name: "创建 Passkey" })).toBeEnabled();
  } else {
    await expect(page.getByText("当前环境不能使用 Passkey", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建 Passkey" })).toBeDisabled();
  }
  await expect(page.locator("#root")).not.toBeEmpty();
});
