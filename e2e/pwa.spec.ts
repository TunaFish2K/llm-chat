import { expect, test, type Page } from "@playwright/test";
import { openChat } from "./helpers";

test("the service worker registers and controls the app in every desktop engine", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "Desktop engines cover the service-worker contract");
  await openChat(page, request);
  expect(await waitForServiceWorkerControl(page)).toBe(true);
});

test("Chromium serves the shell offline while APIs remain network-only", async ({ page, request, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Playwright offline emulation is reliable in Chromium");
  const { conversationId } = await openChat(page, request);
  expect(await waitForServiceWorkerControl(page)).toBe(true);

  const onlineApi = await page.evaluate(async () => {
    const response = await fetch("/api/bootstrap");
    return { ok: response.ok, cacheControl: response.headers.get("cache-control") };
  });
  expect(onlineApi).toEqual({ ok: true, cacheControl: "no-store" });

  await context.setOffline(true);
  try {
    const offlineApi = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/bootstrap");
        return { resolved: true, status: response.status };
      } catch {
        return { resolved: false, status: 0 };
      }
    });
    expect(offlineApi).toEqual({ resolved: false, status: 0 });

    await page.goto(`/c/${conversationId}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.getByRole("heading", { name: "无法连接服务" })).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.setOffline(false);
  }
});

async function waitForServiceWorkerControl(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return true;
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 10_000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timeout);
        resolve(Boolean(navigator.serviceWorker.controller));
      }, { once: true });
    });
  });
}
