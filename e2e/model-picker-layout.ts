import { expect, type Page } from "./fixtures";

/** Measure the visible viewport, including changes while a picker is open. */
export async function expectModelPickerInsideViewport(page: Page) {
  await expect.poll(async () => page.locator(".model-picker-popover").evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    return rect.width > 0 && rect.height > 0 &&
      rect.left >= left + 11 && rect.top >= top + 11 &&
      rect.right <= left + width - 11 && rect.bottom <= top + height - 11;
  }), { message: "Model picker must fit all four viewport edges with a 12px margin" }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
